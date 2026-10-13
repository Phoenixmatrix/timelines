// Step context (CORE-231): what an agent attaches to a commit it makes at a
// meaningful step, stored per (change, commit) and read by anyone who can read
// the repository.
//
//   POST   /api/repos/:owner/:name/steps                       gm uploads one step (write access)
//   GET    /api/repos/:owner/:name/steps?timeline=&issue=&commits=&cursor=&limit=   newest first
//   GET    /api/repos/:owner/:name/steps/:changeId             every version of a change
//   DELETE /api/repos/:owner/:name/steps/:changeId/:commitOid  delete or redact (admins)
//   PUT    /api/repos/:owner/:name/steps/artifacts/screenshots/<name>  a CI job's image (CORE-383)
//   PUT    /api/repos/:owner/:name/steps/artifacts/documents/<name>    a CI job's diagram
//   GET    /api/repos/:owner/:name/steps/artifacts/:id        a stored screenshot (readers)
//
// A step is verified once a push has shown Gitmatrix its commit (here, at
// upload, or later in worker/ref-log/record.ts); until then it's reported as
// "local, unverified". Context is the agent's account, never rewritten: an
// amend or rebase is a new commit, so a new version of the change's context.

import { Hono, type Context } from "hono";
import type { Selectable } from "kysely";
import {
  EMPTY_CONTEXT,
  STEP_ARTIFACT_LIMITS,
  STEP_LIMITS,
  type ContextEntry,
  type ContextSource,
  type Step,
  type StepArtifact,
  type StepAuthor,
  type StepContextBody,
  type StepDocument,
  type StepImageType,
  type StepScreenshot,
  type StepFeedRecord,
  STEP_FEED_DAYS,
  type StepPage,
  type StepTest,
  type StepTestSummary,
  type StepUpload,
  type StepVersions,
} from "../../shared/steps.ts";
import type { AppEnv } from "../auth.ts";
import { readBounded, sha256 } from "../api/bytes.ts";
import { fail, requireActor } from "../api/http.ts";
import { loadRepo, loadSourceRepo } from "../api/repos.ts";
import { noteAgentPresence } from "../agent-presence.ts";
import { RepoReader } from "../objects.ts";
import { durableStub } from "../durable/registry.ts";
import { avatarUrl, EXTENSION, imageType } from "../avatars/api.ts";
import { jobCaller, jobSecret, type JobCaller } from "../deployments/job.ts";
import { findRepo, sqlNow, type RepoRow } from "../db.ts";
import { db, nowIso, type Database } from "../schema.ts";
import { deleteUnreferenced } from "./objects.ts";
import { resolveSource } from "../timelines/sources.ts";

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

/** D1 bounds bound parameters per query: commits looked up at once. */
const ROWS_PER_QUERY = 90;

function toStep(row: Row, authors: Map<string, StepAuthor>): Omit<Step, "artifacts"> {
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
  const artifacts = await artifactsOf(c.env.DB, rows);
  return rows.map((row) => ({
    ...toStep(row, authors),
    artifacts: artifacts.get(row.commit_oid) ?? [],
  }));
}

/** Where a repository's step routes live, for links in what they return. */
async function stepsPath(d1: D1Database, repoId: string): Promise<string | null> {
  const row = await db(d1)
    .selectFrom("repos as r")
    .innerJoin("accounts as o", "o.id", "r.owner_id")
    .select(["o.slug", "r.name"])
    .where("r.id", "=", repoId)
    .executeTakeFirst();
  return row ? `/api/repos/${row.slug}/${row.name}/steps` : null;
}

const IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp"];

/** The stored screenshot's data when it has the shape we wrote; null otherwise. */
function screenshotData(value: unknown): StepScreenshot | null {
  const d = value as Partial<StepScreenshot> | null;
  return d &&
    typeof d.name === "string" &&
    IMAGE_TYPES.includes(d.contentType as string) &&
    typeof d.bytes === "number" &&
    typeof d.sha256 === "string" &&
    typeof d.job === "string"
    ? (d as StepScreenshot)
    : null;
}

function documentData(value: unknown): StepDocument | null {
  const d = value as Partial<StepDocument> | null;
  return d &&
    typeof d.name === "string" &&
    d.format === "mermaid" &&
    typeof d.source === "string" &&
    typeof d.job === "string"
    ? (d as StepDocument)
    : null;
}

/** A screenshot's link: the content hash in the query busts caches when it changes. */
const screenshotUrl = (base: string, id: string, data: StepScreenshot) =>
  `${base}/artifacts/${encodeURIComponent(id)}?v=${data.sha256.slice(0, 16)}`;

/** One stored artifact as the API shows it; null when its data isn't the shape we wrote. */
function toArtifact(
  common: Pick<StepArtifact, "id" | "runId" | "runNumber" | "createdAt">,
  kind: "test-summary" | "screenshot" | "document",
  data: unknown,
  base: string | null,
): StepArtifact | null {
  if (kind === "test-summary") return { ...common, kind, data: data as StepTestSummary };
  if (kind === "screenshot") {
    const shot = screenshotData(data);
    return shot && base
      ? { ...common, kind, data: shot, url: screenshotUrl(base, common.id, shot) }
      : null;
  }
  const document = documentData(data);
  return document ? { ...common, kind, data: document } : null;
}

/** Step runs' artifacts for these steps' commits, newest first (CORE-235). */
async function artifactsOf(d1: D1Database, rows: Row[]): Promise<Map<string, StepArtifact[]>> {
  const out = new Map<string, StepArtifact[]>();
  const repoId = rows[0]?.repo_id;
  if (!repoId) return out;
  const commits = [...new Set(rows.map((r) => r.commit_oid))];
  let base: string | null | undefined;
  for (let i = 0; i < commits.length; i += ROWS_PER_QUERY) {
    const found = await db(d1)
      .selectFrom("step_artifacts as a")
      .innerJoin("ci_runs as r", "r.id", "a.run_id")
      .select(["a.id", "a.commit_oid", "a.run_id", "a.kind", "a.data", "a.created_at", "r.number"])
      .where("a.repo_id", "=", repoId)
      .where("a.commit_oid", "in", commits.slice(i, i + ROWS_PER_QUERY))
      .orderBy("a.created_at", "desc")
      .execute();
    for (const row of found) {
      let data: unknown = {};
      try {
        data = JSON.parse(row.data);
      } catch {
        // Keep a test summary; its data is unreadable.
      }
      if (row.kind === "screenshot") base ??= await stepsPath(d1, repoId);
      const artifact = toArtifact(
        { id: row.id, runId: row.run_id, runNumber: row.number, createdAt: row.created_at },
        row.kind,
        data,
        base ?? null,
      );
      if (artifact) out.set(row.commit_oid, [...(out.get(row.commit_oid) ?? []), artifact]);
    }
  }
  return out;
}

/**
 * The step context for each of these commits (CORE-243: why on a line): the
 * commit's own step, else, for a commit a rebase or landing replaced, the
 * newest step of its change. Deleted steps come back as tombstones.
 */
export async function stepsFor(
  c: Context<AppEnv>,
  repoId: string,
  commits: { oid: string; changeId: string | null }[],
): Promise<Map<string, Step>> {
  const out = new Map<string, Step>();
  if (!commits.length) return out;
  const kdb = db(c.env.DB);
  const exact: Row[] = [];
  const oids = [...new Set(commits.map((x) => x.oid))];
  for (let i = 0; i < oids.length; i += ROWS_PER_QUERY)
    exact.push(
      ...(await kdb
        .selectFrom("step_contexts")
        .selectAll()
        .where("repo_id", "=", repoId)
        .where("commit_oid", "in", oids.slice(i, i + ROWS_PER_QUERY))
        .execute()),
    );
  const found = new Set(exact.map((r) => r.commit_oid));
  const byChange = new Map<string, string[]>();
  for (const { oid, changeId } of commits)
    if (!found.has(oid) && changeId)
      byChange.set(changeId, [...(byChange.get(changeId) ?? []), oid]);
  const versions: Row[] = [];
  const changes = [...byChange.keys()];
  for (let i = 0; i < changes.length; i += ROWS_PER_QUERY)
    versions.push(
      ...(await kdb
        .selectFrom("step_contexts")
        .selectAll()
        .where("repo_id", "=", repoId)
        .where("change_id", "in", changes.slice(i, i + ROWS_PER_QUERY))
        .orderBy("committed_at", "desc")
        .execute()),
    );
  const newest = new Map<string, Row>();
  for (const row of versions) if (!newest.has(row.change_id)) newest.set(row.change_id, row);
  const rows = [...exact, ...newest.values()];
  const steps = await present(c, rows);
  rows.forEach((row, i) => {
    const step = steps[i]!;
    if (row.commit_oid && found.has(row.commit_oid)) out.set(row.commit_oid, step);
    for (const oid of byChange.get(row.change_id) ?? []) if (!out.has(oid)) out.set(oid, step);
  });
  return out;
}

/** Whether a push has shown this commit as this change (worker/ref-log). */
async function seen(d1: D1Database, repoId: string, changeId: string, oid: string) {
  const member = await db(d1)
    .selectFrom("source_progress_members")
    .select("commit_oid")
    .where("repo_id", "=", repoId)
    .where("commit_oid", "=", oid)
    .executeTakeFirst();
  if (member) return true;
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
      oc
        .columns(["repo_id", "change_id", "commit_oid"])
        .doUpdateSet({
          timeline: values.timeline,
          issue_key: values.issue_key,
          summary: values.summary,
          context: values.context,
          committed_at: values.committed_at,
          ...(verified ? { verified_at: sqlNow } : {}),
        })
        .where("step_contexts.author_id", "=", authorId)
        .where("step_contexts.deleted_at", "is", null),
    )
    .execute();
  // Close the upload/push race: a membership inserted after the first check
  // may have tried to verify this row before the insert above existed.
  if (!verified && (await seen(c.env.DB, repoId, changeId, commitOid))) {
    await db(c.env.DB)
      .updateTable("step_contexts")
      .set({ verified_at: sqlNow })
      .where("repo_id", "=", repoId)
      .where("change_id", "=", changeId)
      .where("commit_oid", "=", commitOid)
      .where("verified_at", "is", null)
      .execute();
  }
  const row = await db(c.env.DB)
    .selectFrom("step_contexts")
    .selectAll()
    .where("repo_id", "=", repoId)
    .where("change_id", "=", changeId)
    .where("commit_oid", "=", commitOid)
    .executeTakeFirstOrThrow();
  if (row.author_id !== authorId)
    return fail(c, 409, "This step's context belongs to whoever made the commit.");
  if (row.deleted_at) return fail(c, 410, "This step's context was deleted.");
  const [step] = await present(c, [row]);
  // A new step in a timeline goes out on its live feed (CORE-239), after the answer.
  if (!existing && step!.timeline && Reflect.has(c.env, "STEP_FEED")) {
    const work = publishStep(c.env, loaded.row, step!).catch((error) =>
      console.error("Steps: publishing to the live feed failed", error),
    );
    try {
      c.executionCtx.waitUntil(work);
    } catch {
      await work;
    }
  }
  return c.json(step, existing ? 200 : 201);
});

/**
 * How long the repository's account keeps live feed records (retention
 * category "step-feed", CORE-244): its stored days within 1–7, else 7.
 */
async function feedKeepMs(env: Env, repoId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT p.thresholds FROM retention_policies p JOIN repos r ON r.owner_id = p.account_id
     WHERE r.id = ? AND p.category = 'step-feed'`,
  )
    .bind(repoId)
    .first<{ thresholds: string }>();
  let days: unknown;
  try {
    days = row ? (JSON.parse(row.thresholds) as { days?: unknown }).days : undefined;
  } catch {
    days = undefined;
  }
  const kept =
    typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= STEP_FEED_DAYS
      ? days
      : STEP_FEED_DAYS;
  return kept * 24 * 60 * 60_000;
}

/** The live feed of one repository's steps in one timeline. */
function feed(env: Env, repoId: string, timeline: string) {
  return durableStub(env, "StepFeed", `${repoId}:${timeline}`, { repo: repoId });
}

async function publishStep(
  env: Env,
  repo: { id: string; owner_slug: string; name: string },
  step: Step,
) {
  const tests = step.context.tests;
  const record: Omit<StepFeedRecord, "seq" | "at"> = {
    repo: `${repo.owner_slug}/${repo.name}`,
    timeline: step.timeline!,
    changeId: step.changeId,
    commitOid: step.commitOid,
    summary: step.summary,
    issue: step.issue,
    author: { id: step.author.id, kind: step.author.kind, name: step.author.name },
    tests: tests.length
      ? {
          passed: tests.filter((t) => t.exit === 0).length,
          failed: tests.filter((t) => t.exit !== 0).length,
        }
      : null,
    why: (step.context.why.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 200),
    committedAt: step.committedAt,
  };
  await feed(env, repo.id, step.timeline!).publish(record, await feedKeepMs(env, repo.id));
}

/**
 * Tells a timeline's live feed to forget deleted steps (CORE-399), so no
 * reader sees their summary or why again. A feed that fails is only logged:
 * the step is deleted either way, and the next reader to connect asks again.
 */
async function forgetOnFeed(
  env: Env,
  repo: { id: string; owner_slug: string; name: string },
  timeline: string,
  deleted: { change_id: string; commit_oid: string }[],
) {
  try {
    await feed(env, repo.id, timeline).forget(
      deleted.map((d) => ({
        repo: `${repo.owner_slug}/${repo.name}`,
        changeId: d.change_id,
        commitOid: d.commit_oid,
      })),
    );
  } catch (error) {
    console.error("Steps: removing a deleted step from the live feed failed", error);
  }
}

/**
 * GET /live?timeline=<slug>: the timeline's steps in this repository as
 * Server-Sent Events, for anyone who can read it (CORE-239). Each connection
 * is checked; a stream ends after ten minutes and reconnects with
 * Last-Event-ID, checked again.
 */
steps.get("/live", async (c) => {
  const loaded = await loadRepo(c, "read");
  if (loaded instanceof Response) return loaded;
  const timeline = c.req.query("timeline") ?? "";
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(timeline))
    return fail(c, 400, "timeline is a timeline's slug.");
  const headers = new Headers();
  const last = c.req.header("last-event-id") ?? c.req.query("after");
  if (last && /^\d+$/.test(last)) headers.set("last-event-id", last);
  // Steps deleted while their record could still be kept: the feed forgets
  // them first, in case telling it at deletion failed (CORE-399). Usually none.
  const since = new Date(Date.now() - STEP_FEED_DAYS * 24 * 60 * 60_000).toISOString();
  const deleted = await db(c.env.DB)
    .selectFrom("step_contexts")
    .select(["change_id", "commit_oid"])
    .where("repo_id", "=", loaded.row.id)
    .where("timeline", "=", timeline)
    .where("deleted_at", ">=", since)
    .orderBy("deleted_at", "desc")
    .limit(200)
    .execute();
  if (deleted.length) await forgetOnFeed(c.env, loaded.row, timeline, deleted);
  const response = await feed(c.env, loaded.row.id, timeline).fetch(
    new Request("https://step-feed/subscribe", { headers }),
  );
  return new Response(response.body, response);
});

// Step artifacts (CORE-383): what a CI job attaches to its run's commit.

/** The CI job behind the request's credential, for its own repository only. */
async function artifactJob(
  c: Context<AppEnv>,
): Promise<{ repo: RepoRow; job: JobCaller } | Response> {
  const secret = jobSecret(c.req.header("authorization"));
  if (!secret)
    return fail(c, 401, "Only a CI job uploads step artifacts, with its own credential.");
  const job = await jobCaller(c.env.DB, secret);
  if (!job) return fail(c, 401, "The CI job's credential is invalid, or the job has ended.");
  const repo = await findRepo(
    c.env.DB,
    null,
    c.req.param("owner") ?? "",
    c.req.param("name") ?? "",
  );
  if (!repo || repo.id !== job.repoId)
    return fail(c, 403, "A CI job uploads artifacts for its own repository only.");
  if (job.sourceId !== "canonical") await resolveSource(c.env, repo, job.sourceId);
  return { repo, job };
}

/**
 * Stores one artifact row for the job's run, replacing the run's earlier
 * upload of the same name. Respond as the step lists would show it.
 */
async function putArtifact(
  c: Context<AppEnv>,
  caller: { repo: RepoRow; job: JobCaller },
  kind: "screenshot" | "document",
  name: string,
  data: StepScreenshot | StepDocument,
  store?: { key: string; bytes: Uint8Array; type: StepImageType },
) {
  const { repo, job } = caller;
  const kdb = db(c.env.DB);
  const id = `${job.runId}:${kind}:${name}`;
  const existing = await kdb
    .selectFrom("step_artifacts")
    .select("object_key")
    .where("id", "=", id)
    .executeTakeFirst();
  if (!existing) {
    const { n } = await kdb
      .selectFrom("step_artifacts")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("run_id", "=", job.runId)
      .where("kind", "in", ["screenshot", "document"])
      .executeTakeFirstOrThrow();
    if (Number(n) >= STEP_ARTIFACT_LIMITS.perRun)
      return fail(
        c,
        409,
        `A run attaches up to ${STEP_ARTIFACT_LIMITS.perRun} screenshots and documents.`,
      );
  }
  if (store)
    await c.env.STEP_ARTIFACTS.put(store.key, store.bytes, {
      httpMetadata: { contentType: store.type },
    });
  const values = {
    kind,
    data: JSON.stringify(data),
    object_key: store?.key ?? null,
    created_at: nowIso(),
  };
  try {
    await kdb
      .insertInto("step_artifacts")
      .values({ id, repo_id: repo.id, commit_oid: job.commit, run_id: job.runId, ...values })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          data: values.data,
          object_key: values.object_key,
          created_at: values.created_at,
        }),
      )
      .execute();
  } catch (error) {
    // Don't leave the just-put image behind with no row to find it by.
    if (store)
      await deleteUnreferenced(c.env, [store.key]).catch((e) =>
        console.warn(`step artifact ${store.key} left after a failed save: ${String(e)}`),
      );
    throw error;
  }
  // A replacement that stored a different image frees the old one, unless
  // another artifact (the same picture under another name) still shows it.
  // The upload has succeeded by now, so a failure here is only a leftover.
  const old = existing?.object_key;
  if (old && old !== store?.key)
    await deleteUnreferenced(c.env, [old]).catch((e) =>
      console.warn(`step artifact ${old} left after a replacement: ${String(e)}`),
    );
  const artifact = toArtifact(
    { id, runId: job.runId, runNumber: job.runNumber, createdAt: values.created_at },
    kind,
    data,
    `/api/repos/${repo.owner_slug}/${repo.name}/steps`,
  );
  return c.json(artifact, existing ? 200 : 201);
}

function artifactName(c: Context<AppEnv>): string | Response {
  // Not `:name`, which is the repository's.
  const name = c.req.param("artifact") ?? "";
  return STEP_ARTIFACT_LIMITS.name.test(name)
    ? name
    : fail(
        c,
        400,
        "name is 1-80 letters, digits, spaces, dots, underscores or hyphens, starting with a letter or digit.",
      );
}

steps.put("/artifacts/screenshots/:artifact", async (c) => {
  const caller = await artifactJob(c);
  if (caller instanceof Response) return caller;
  const name = artifactName(c);
  if (name instanceof Response) return name;
  const body = c.req.raw.body;
  if (!body) return fail(c, 400, "Send the image as the request body.");
  const bytes = await readBounded(body, STEP_ARTIFACT_LIMITS.imageBytes);
  if (!bytes) return fail(c, 413, "Keep a screenshot under 2 MiB.");
  // The bytes decide the type; the request's Content-Type is never trusted, and SVG never matches.
  const type = imageType(bytes);
  if (!type) return fail(c, 415, "Send a PNG, JPEG or WebP image.");
  const hash = await sha256(bytes);
  const data: StepScreenshot = {
    name,
    contentType: type,
    bytes: bytes.byteLength,
    sha256: hash,
    job: caller.job.jobName,
  };
  const key = `step-artifacts/${caller.repo.id}/${caller.job.runId}/${hash}.${EXTENSION[type]}`;
  return putArtifact(c, caller, "screenshot", name, data, { key, bytes, type });
});

steps.put("/artifacts/documents/:artifact", async (c) => {
  const caller = await artifactJob(c);
  if (caller instanceof Response) return caller;
  const name = artifactName(c);
  if (name instanceof Response) return name;
  const body = c.req.raw.body;
  if (!body) return fail(c, 400, "Send the diagram as JSON.");
  // Characters take up to four bytes in UTF-8, plus the JSON around the source.
  const raw = await readBounded(body, STEP_ARTIFACT_LIMITS.documentChars * 4 + 1024);
  if (!raw) return fail(c, 413, "Keep a diagram under 50,000 characters.");
  let upload: { format?: unknown; source?: unknown };
  try {
    upload = JSON.parse(new TextDecoder().decode(raw)) as typeof upload;
  } catch {
    return fail(c, 400, "Send the diagram as JSON.");
  }
  if (upload?.format !== "mermaid") return fail(c, 400, 'format is "mermaid".');
  if (typeof upload.source !== "string" || !upload.source.trim())
    return fail(c, 400, "source is the diagram's text.");
  if (upload.source.length > STEP_ARTIFACT_LIMITS.documentChars)
    return fail(c, 413, "Keep a diagram under 50,000 characters.");
  const data: StepDocument = {
    name,
    format: "mermaid",
    source: upload.source,
    job: caller.job.jobName,
  };
  return putArtifact(c, caller, "document", name, data);
});

steps.get("/artifacts/:id", async (c) => {
  const loaded = await loadRepo(c, "read");
  if (loaded instanceof Response) return loaded;
  const row = await db(c.env.DB)
    .selectFrom("step_artifacts")
    .select(["kind", "data", "object_key"])
    .where("id", "=", c.req.param("id") ?? "")
    .where("repo_id", "=", loaded.row.id)
    .executeTakeFirst();
  let data: StepScreenshot | null = null;
  try {
    data = row ? screenshotData(JSON.parse(row.data)) : null;
  } catch {
    data = null;
  }
  const object =
    row?.kind === "screenshot" && row.object_key && data
      ? await c.env.STEP_ARTIFACTS.get(row.object_key)
      : null;
  if (!object || !data) return fail(c, 404, "No such screenshot.");
  // Only a link carrying this image's hash (?v=, as artifactsOf writes it) may be
  // cached for good; the same id replaced by another upload serves new bytes.
  const current = c.req.query("v") === data.sha256.slice(0, 16);
  return new Response(object.body, {
    headers: {
      "content-type": data.contentType,
      "cache-control": current ? "private, max-age=31536000, immutable" : "private, no-cache",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
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
  const loaded = await loadSourceRepo(c, "read");
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
  // `gm log --context` asks for the steps of the commits it shows, in one call.
  const commitsParam = c.req.query("commits");
  if (commitsParam) {
    const commits = commitsParam.split(",").filter(Boolean);
    if (commits.length > 100 || commits.some((oid) => !/^[0-9a-f]{40}$/.test(oid)))
      return fail(c, 400, "commits is up to 100 comma-separated 40-character commit hashes.");
    if (commits.length > 0) query = query.where("commit_oid", "in", commits);
  }
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
  // A single remote context inspection (for example `gm show --context`)
  // concerns one commit; batch log enumeration never visits every result.
  if (c.get("actor")?.agent && commitsParam && COMMIT_OID.test(commitsParam)) {
    try {
      const objects = new RepoReader(
        c.env,
        loaded.row.artifacts_name,
        loaded.row.artifacts_remote,
        c.get("timing"),
        (work) => c.executionCtx.waitUntil(work),
        loaded.source.sourceId !== "canonical" ? loaded.source.ref : undefined,
      );
      let commit;
      try {
        commit = await objects.commit(commitsParam);
      } finally {
        await objects.close();
      }
      if (commit)
        noteAgentPresence(c, {
          kind: "commit",
          scopeId: loaded.canonical.id,
          resourceId: commit.hash,
          sourceId: loaded.source.sourceId,
        });
    } catch {
      console.warn("Recent agent presence could not be recorded.");
    }
  }
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
  const deleted = await db(c.env.DB)
    .updateTable("step_contexts")
    .set({ context: "{}", summary: "", deleted_at: sqlNow, deleted_by: actor.id })
    .where("repo_id", "=", loaded.row.id)
    .where("change_id", "=", c.req.param("changeId"))
    .where("commit_oid", "=", c.req.param("commitOid"))
    .where("deleted_at", "is", null)
    .returning(["change_id", "commit_oid", "timeline"])
    .executeTakeFirst();
  if (!deleted) return fail(c, 404, "No such step, or it's already deleted.");
  // Its live feed replays records for a week: it forgets this one, before the answer.
  if (deleted.timeline && Reflect.has(c.env, "STEP_FEED"))
    await forgetOnFeed(c.env, loaded.row, deleted.timeline, [deleted]);
  return c.body(null, 204);
});
