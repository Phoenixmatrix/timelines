// Repository deletion (CORE-199): tombstone, then purge everywhere.
//
// Deleting a repository used to delete its row and let D1 cascade, which
// orphaned whatever only those rows could find: Vectorize vectors (ids from
// kg_nodes), AI Search items (kg_search_items), the KnowledgeCoordinator,
// live timeline previews (their deployments rows went before the sweep could
// tear them down), atlas_spend rows and the registry's package_sources and
// publishes links. Now:
//
// 1. `requestDeletion` sets repos.deleted_at and records the deletion in
//    repo_deletions, at once: the repository is missing to every reader from
//    then on (selectRepos and the other lookups skip it), and its name stays
//    taken until the purge ends.
// 2. The RepoPurge Workflow (repo-purge.ts) runs `runPurge`, phase by phase,
//    each step bounded and idempotent, recording its phase and progress in
//    repo_deletions: stop (purge the coordinator, terminate its builds, cancel
//    CI), previews (claim the live ones, start their teardown runs, wait for
//    them), vectors, search, durable (every registered instance the
//    repository owns), links (atlas_spend, registry), artifacts, and last the
//    rows (children in bounded batches, then the repository row's cascade).
// 3. The hourly cron (`resumeDeletions`) starts a new instance for a deletion
//    whose Workflow died; it resumes from the recorded phase.
//
// The orphan sweep (repo-orphans.ts) runs repositories deleted before this
// existed through the same phases that need no repository row.

import { previewBranch, startPreviewRuns } from "../deployments/previews.ts";
import { cancelRun } from "../ci/cancel.ts";
import { forgetUpstreamTokens } from "../artifacts.ts";
import { peekStub, purgeInstance } from "../durable/registry.ts";
import { DURABLE_CLASSES, type DurableClass } from "../durable/classes.ts";
import { vectorId, SEARCH_INSTANCE } from "../knowledge/indexes.ts";
import { pool } from "../knowledge/util.ts";
import { db, nowIso } from "../schema.ts";
import { drainDeletedRepoSources } from "./work-sources.ts";

/** The phases, in order; `done` once the last has run. */
export const PHASES = [
  "stop",
  "previews",
  "vectors",
  "search",
  "durable",
  "links",
  "artifacts",
  "rows",
] as const;
export type Phase = (typeof PHASES)[number] | "done";
/** An orphan has no repository row: only the phases that don't need one. */
const ORPHAN_PHASES: ReadonlySet<Phase> = new Set([
  "stop",
  "vectors",
  "search",
  "durable",
  "links",
]);

export const PURGE_LIMITS = {
  /** kg_nodes rows whose vectors one step deletes, and ids per deleteByIds. */
  nodesPerStep: 1000,
  vectorIdsPerCall: 100,
  /** AI Search items one step deletes, and at once. */
  itemsPerStep: 100,
  itemConcurrency: 6,
  /**
   * Metadata-filtered sweeps for stragglers: at most this many rounds, waits
   * of 20 seconds then a minute (Vectorize took 3 minutes to apply a delete
   * in testing), ended by this many empty rounds in a row.
   */
  sweepRounds: 20,
  sweepWait: "20 seconds",
  sweepSlowWait: "1 minute",
  sweepFastRounds: 6,
  emptyRounds: 2,
  /** Durable Object instances one step purges. */
  instancesPerStep: 20,
  /** CI runs one step cancels. */
  runsPerStep: 50,
  /** Registry publishes one statement unlinks. */
  publishesPerStatement: 2000,
  /** Child rows one statement deletes, and statements per step. */
  rowsPerStatement: 2000,
  statementsPerStep: 40,
  /** How long the purge waits for preview teardown runs before cancelling them. */
  teardownWaitMs: 2 * 60 * 60_000,
} as const;

export type Limits = typeof PURGE_LIMITS;

/** Step options: retried with backoff, each step well inside the limit. */
export const STEP = {
  retries: { limit: 6, delay: "10 seconds", backoff: "exponential" },
  timeout: "5 minutes",
} as const;

/** The part of a Workflow step the purge uses (tests pass their own). */
export interface PurgeStep {
  do<T>(name: string, config: typeof STEP, work: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: string): Promise<void>;
}

/** One timeline's previews in the repository, torn down together. */
export interface PreviewGroup {
  timeline: string;
  deployments: number[];
  commit: string;
  checkpoint: string | null;
  run: { id: string; number: number } | null;
  skipped: string | null;
}

/** What repo_deletions.progress holds. */
export interface Progress {
  stop?: { coordinator: boolean; terminated: number; cancelled: number };
  previews?: {
    startedAt: string;
    groups: PreviewGroup[];
    timedOut?: number;
  };
  /** `cursor`: the last kg_nodes id done (no nulls here: json_patch drops them). */
  vectors?: { cursor: string; done: boolean; deleted: number; swept: number; remaining?: number };
  search?: { deleted: number; swept: number; remaining?: number };
  durable?: { purged: number; failed: number };
  links?: {
    spendDeleted: number;
    spendDetached: number;
    exhaustions: number;
    sources: number;
    publishes: number;
  };
  artifacts?: { deleted: boolean };
  rows?: Record<string, number>;
}

export interface DeletionRow {
  repo_id: string;
  owner_id: string;
  full_name: string;
  artifacts_name: string | null;
  source: "delete" | "orphan-sweep";
  phase: string;
  progress: string;
  workflow_id: string | null;
  attempts: number;
  finished_at: string | null;
}

type Waiter = (work: Promise<unknown>) => void;

// ---- starting --------------------------------------------------------------

/**
 * Tombstone a repository and record its deletion, in one transaction. False
 * when it was already being deleted (or is gone).
 */
export async function requestDeletion(
  env: Env,
  repo: {
    id: string;
    owner_id: string;
    owner_slug: string;
    name: string;
    artifacts_name: string;
  },
  requestedBy: string | null,
): Promise<boolean> {
  const at = nowIso();
  const [marked] = await env.DB.batch([
    env.DB.prepare(
      "UPDATE repos SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL RETURNING id",
    ).bind(repo.id, at),
    env.DB.prepare(
      `INSERT INTO repo_deletions
         (repo_id, owner_id, full_name, artifacts_name, source, requested_by, requested_at, phase, updated_at)
       SELECT ?1, ?2, ?3, ?4, 'delete', ?5, ?6, 'stop', ?6
       WHERE EXISTS (SELECT 1 FROM repos WHERE id = ?1 AND deleted_at = ?6)
       ON CONFLICT (repo_id) DO NOTHING`,
    ).bind(
      repo.id,
      repo.owner_id,
      `${repo.owner_slug}/${repo.name}`,
      repo.artifacts_name,
      requestedBy,
      at,
    ),
  ]);
  return (marked?.results?.length ?? 0) > 0;
}

/** The purge Workflow, when this deployment has one (a preview has none). */
function purgeWorkflow(env: Env): Workflow<{ repoId: string }> | undefined {
  return Reflect.get(env, "REPO_PURGE") as Workflow<{ repoId: string }> | undefined;
}

/**
 * Start (or restart) a deletion's purge: a new Workflow instance, or inline
 * in the background where there is no Workflow (a timeline preview).
 */
export async function launchPurge(
  env: Env,
  repoId: string,
  waitUntil: Waiter,
): Promise<string | null> {
  const row = await db(env.DB)
    .updateTable("repo_deletions")
    .set((eb) => ({ attempts: eb("attempts", "+", 1), updated_at: nowIso() }))
    .where("repo_id", "=", repoId)
    .where("finished_at", "is", null)
    .returning(["attempts"])
    .executeTakeFirst();
  if (!row) return null;
  const workflow = purgeWorkflow(env);
  if (!workflow) {
    waitUntil(
      runPurge(env, repoId, inlineStep(), { waitUntil }).catch((error: unknown) =>
        console.error("Repository deletion: the inline purge failed", { repoId, error }),
      ),
    );
    return null;
  }
  // Workflow ids allow letters, digits, - and _.
  const id = `purge-${repoId.replace(/[^A-Za-z0-9_-]/g, "-")}-${row.attempts}`.slice(0, 100);
  await workflow.create({ id, params: { repoId } });
  await db(env.DB)
    .updateTable("repo_deletions")
    .set({ workflow_id: id })
    .where("repo_id", "=", repoId)
    .execute();
  return id;
}

/**
 * A step that just runs (inline, no Workflow): one retry, and sleeps of at
 * most two seconds, since it lives on its request's waitUntil (about 30 s).
 */
export function inlineStep(): PurgeStep {
  return {
    async do(_name, _config, work) {
      try {
        return await work();
      } catch {
        return work();
      }
    },
    async sleep(_name, duration) {
      const seconds = Number(/^(\d+)/.exec(duration)?.[1] ?? "1");
      await new Promise((resolve) => setTimeout(resolve, Math.min(seconds, 2) * 1000));
    },
  };
}

const LIVE_INSTANCE = new Set(["queued", "running", "waiting", "paused", "waitingForPause"]);

/**
 * The cron's part: start a new instance for each unfinished deletion that
 * made no progress for `staleMs` and whose Workflow isn't alive. It resumes
 * from the phase recorded.
 */
export async function resumeDeletions(
  env: Env,
  options: { waitUntil: Waiter; now?: number; staleMs?: number; limit?: number; repoId?: string },
): Promise<string[]> {
  const now = options.now ?? Date.now();
  const before = new Date(now - (options.staleMs ?? 15 * 60_000)).toISOString();
  let query = db(env.DB)
    .selectFrom("repo_deletions")
    .select(["repo_id", "workflow_id"])
    .where("finished_at", "is", null)
    .where("updated_at", "<=", before);
  if (options.repoId) query = query.where("repo_id", "=", options.repoId);
  const rows = await query
    .orderBy("updated_at")
    .limit(options.limit ?? 10)
    .execute();
  const started: string[] = [];
  const workflow = purgeWorkflow(env);
  for (const row of rows) {
    try {
      if (row.workflow_id && workflow) {
        const instance = await workflow.get(row.workflow_id).catch(() => null);
        const status = instance ? await instance.status().catch(() => null) : null;
        if (status && LIVE_INSTANCE.has(status.status)) continue;
      }
      await launchPurge(env, row.repo_id, options.waitUntil);
      started.push(row.repo_id);
    } catch (error) {
      console.error("Repository deletion: restarting a purge failed", {
        repo: row.repo_id,
        error,
      });
    }
  }
  return started;
}

// ---- the purge -------------------------------------------------------------

async function loadDeletion(env: Env, repoId: string): Promise<DeletionRow | null> {
  const row = await db(env.DB)
    .selectFrom("repo_deletions")
    .select([
      "repo_id",
      "owner_id",
      "full_name",
      "artifacts_name",
      "source",
      "phase",
      "progress",
      "workflow_id",
      "attempts",
      "finished_at",
    ])
    .where("repo_id", "=", repoId)
    .executeTakeFirst();
  return row ?? null;
}

function parseProgress(text: string): Progress {
  try {
    return JSON.parse(text) as Progress;
  } catch {
    return {};
  }
}

/** Merge into the deletion's progress (and show it's alive). */
async function saveProgress(env: Env, repoId: string, patch: Progress): Promise<void> {
  await env.DB.prepare(
    "UPDATE repo_deletions SET progress = json_patch(progress, ?2), updated_at = ?3 WHERE repo_id = ?1",
  )
    .bind(repoId, JSON.stringify(patch), nowIso())
    .run();
}

/** Move the deletion past `phase` (only from it: a stale instance can't move it back). */
async function advance(env: Env, repoId: string, phase: Phase, next: Phase): Promise<void> {
  const at = nowIso();
  await db(env.DB)
    .updateTable("repo_deletions")
    .set({ phase: next, updated_at: at, ...(next === "done" ? { finished_at: at } : {}) })
    .where("repo_id", "=", repoId)
    .where("phase", "=", phase)
    .execute();
}

function nextPhase(phase: Phase, orphan: boolean): Phase {
  for (let i = PHASES.indexOf(phase as (typeof PHASES)[number]) + 1; i < PHASES.length; i++)
    if (!orphan || ORPHAN_PHASES.has(PHASES[i]!)) return PHASES[i]!;
  return "done";
}

export interface PurgeHooks {
  waitUntil: Waiter;
  limits?: Limits;
}

/**
 * Purge a deletion from its recorded phase to the end. Safe to run again from
 * any point: every step re-checks what's left.
 */
export async function runPurge(
  env: Env,
  repoId: string,
  step: PurgeStep,
  hooks: PurgeHooks,
): Promise<Phase | "missing"> {
  const limits = hooks.limits ?? PURGE_LIMITS;
  const start = await step.do("load", STEP, async () => {
    const row = await loadDeletion(env, repoId);
    return row ? { phase: row.phase as Phase, orphan: row.source === "orphan-sweep" } : null;
  });
  if (!start) return "missing";
  const { orphan } = start;
  let phase = start.phase;
  while (phase !== "done") {
    if (orphan && !ORPHAN_PHASES.has(phase)) {
      const next = nextPhase(phase, orphan);
      await step.do(`${phase}:skip`, STEP, () => advance(env, repoId, phase, next));
      phase = next;
      continue;
    }
    switch (phase) {
      case "stop":
        await stopPhase(env, repoId, step, limits);
        break;
      case "previews":
        await previewsPhase(env, repoId, step, hooks.waitUntil, limits);
        break;
      case "vectors":
        await vectorsPhase(env, repoId, step, limits);
        break;
      case "search":
        await searchPhase(env, repoId, step, limits);
        break;
      case "durable":
        await durablePhase(env, repoId, step, limits);
        break;
      case "links":
        await linksPhase(env, repoId, step, limits);
        break;
      case "artifacts":
        await artifactsPhase(env, repoId, step);
        break;
      case "rows":
        await rowsPhase(env, repoId, step, limits);
        break;
    }
    const next = nextPhase(phase, orphan);
    const from = phase;
    await step.do(`${phase}:done`, STEP, () => advance(env, repoId, from, next));
    phase = next;
  }
  return "done";
}

// stop: nothing new may start, and what runs stops.

async function stopPhase(env: Env, repoId: string, step: PurgeStep, limits: Limits) {
  const knowledge = await step.do("stop:knowledge", STEP, () => stopKnowledge(env, repoId));
  let cancelled = 0;
  for (let i = 0; ; i++) {
    const batch = await step.do(`stop:ci:${i}`, STEP, () => stopCi(env, repoId, limits));
    cancelled += batch.cancelled;
    if (!batch.more) break;
  }
  await step.do("stop:record", STEP, () =>
    saveProgress(env, repoId, { stop: { ...knowledge, cancelled } }),
  );
  // A terminated build or queue CI callback may already have an effect in
  // flight. Let it settle before purging stores; tombstones fence new work.
  if (knowledge.terminated > 0 || cancelled > 0) await step.sleep("stop:settle", "1 minute");
  await step.do("stop:ci-acknowledged", STEP, () => assertCiDrained(env, repoId, true));
}

/** Purge the coordinator first (it starts builds), then terminate its builds. */
async function stopKnowledge(
  env: Env,
  repoId: string,
): Promise<{ coordinator: boolean; terminated: number }> {
  const builds = new Set<string>();
  const bound = Boolean(Reflect.get(env, "KNOWLEDGE_COORDINATOR"));
  if (bound) {
    try {
      const status = await peekStub(env, "KnowledgeCoordinator", repoId).status();
      if (status.running) builds.add(status.running.buildId);
      for (const overlay of Object.values(status.overlays))
        if (overlay.running) builds.add(overlay.running.buildId);
      for (const pages of status.pages) builds.add(pages.buildId);
    } catch (error) {
      console.warn("Repository deletion: reading the coordinator failed", { repoId, error });
    }
  }
  // Purged whether or not the registry knew it (purging an empty one is harmless).
  if (bound) await purgeInstance(env, "KnowledgeCoordinator", repoId, "repository deleted");
  const coordinator = bound;
  const running = await db(env.DB)
    .selectFrom("kg_builds")
    .select("id")
    .where("repo_id", "=", repoId)
    .where("status", "=", "running")
    .execute();
  for (const row of running) builds.add(row.id);
  const writing = await db(env.DB)
    .selectFrom("kg_page_sets")
    .select("build_id")
    .where("repo_id", "=", repoId)
    .where("status", "=", "writing")
    .where("build_id", "is not", null)
    .execute();
  for (const row of writing) builds.add(row.build_id!);
  const workflow = Reflect.get(env, "KNOWLEDGE_BUILD") as Workflow | undefined;
  if (workflow)
    for (const id of builds) {
      const instance = await workflow.get(id).catch(() => null);
      await instance?.terminate().catch(() => undefined);
    }
  await db(env.DB)
    .updateTable("kg_builds")
    .set({ status: "failed", error: "The repository was deleted.", finished_at: nowIso() })
    .where("repo_id", "=", repoId)
    .where("status", "=", "running")
    .execute();
  return { coordinator, terminated: builds.size };
}

/** Cancel the repository's CI runs, except preview teardowns (the next phase waits for those). */
async function stopCi(env: Env, repoId: string, limits: Limits) {
  const runs = await db(env.DB)
    .selectFrom("ci_runs")
    .select("id")
    .where("repo_id", "=", repoId)
    .where("status", "in", ["queued", "running"])
    .where((eb) =>
      eb.or([eb("preview_action", "is", null), eb("preview_action", "!=", "teardown")]),
    )
    .limit(limits.runsPerStep)
    .execute();
  for (const run of runs) await cancelRun(env, run.id);
  return { cancelled: runs.length, more: runs.length === limits.runsPerStep };
}

/** A stopped Workflow or elapsed grace period is not runner acknowledgment. */
async function assertCiDrained(env: Env, repoId: string, allowTeardown: boolean) {
  let query = db(env.DB)
    .selectFrom("ci_runs as r")
    .select("r.id")
    .where("r.repo_id", "=", repoId)
    .where((eb) =>
      eb.or([
        eb("r.status", "in", ["queued", "running"]),
        eb.exists(
          eb
            .selectFrom("ci_jobs as j")
            .select("j.id")
            .whereRef("j.run_id", "=", "r.id")
            .where((job) =>
              job.or([
                job("j.status", "in", ["pending", "queued", "running"]),
                job("j.source_completion_pending", "=", 1),
              ]),
            ),
        ),
      ]),
    );
  if (allowTeardown)
    query = query.where((eb) =>
      eb.or([eb("r.preview_action", "is", null), eb("r.preview_action", "!=", "teardown")]),
    );
  const outstanding = await query.executeTakeFirst();
  if (outstanding)
    throw new Error(`Repository deletion awaits CI consumer acknowledgment for ${outstanding.id}`);
}

// previews: the same teardown the hourly sweep starts, then wait for it.

async function previewsPhase(
  env: Env,
  repoId: string,
  step: PurgeStep,
  waitUntil: Waiter,
  limits: Limits,
) {
  await step.do("previews:claim", STEP, () => claimPreviews(env, repoId, waitUntil));
  for (let i = 0; ; i++) {
    const open = await step.do(`previews:check:${i}`, STEP, () =>
      openTeardowns(env, repoId, limits),
    );
    if (!open.runs.length) break;
    if (open.overdue) {
      await step.do("previews:give-up", STEP, async () => {
        for (const run of open.runs) await cancelRun(env, run);
        const progress = parseProgress((await loadDeletion(env, repoId))?.progress ?? "{}");
        await saveProgress(env, repoId, {
          previews: { ...progress.previews!, timedOut: open.runs.length },
        });
      });
      break;
    }
    await step.sleep(
      `previews:wait:${i}`,
      i < 4 ? "15 seconds" : i < 12 ? "1 minute" : "3 minutes",
    );
  }
}

/**
 * Record the live timeline previews as groups, mark them expired, and start
 * a teardown run per group that has none yet. Recording comes first, so a
 * crash between claiming and starting still starts the run on resume.
 */
async function claimPreviews(
  env: Env,
  repoId: string,
  waitUntil: Waiter,
): Promise<{ groups: number; runs: number }> {
  const kdb = db(env.DB);
  const row = await loadDeletion(env, repoId);
  const progress = parseProgress(row?.progress ?? "{}");
  const previews = progress.previews ?? { startedAt: nowIso(), groups: [] };
  // Resume from the recorded deployment identities, never today's routing.
  // Old unadmitted groups could mix physical sources under one timeline slug.
  const normalized: PreviewGroup[] = [];
  for (const group of previews.groups) {
    const records = group.deployments.length
      ? await kdb
          .selectFrom("deployments")
          .select(["id", "source_id", "timeline_slug", "commit_oid", "checkpoint_id"])
          .where("repo_id", "=", repoId)
          .where("id", "in", group.deployments)
          .orderBy("id")
          .execute()
      : [];
    if (records.length !== group.deployments.length || !records.length)
      throw new Error("Saved preview cleanup has missing deployment identities.");
    if (group.run) {
      const admitted = await kdb
        .selectFrom("ci_runs")
        .select(["source_id", "commit_oid"])
        .where("id", "=", group.run.id)
        .where("repo_id", "=", repoId)
        .executeTakeFirst();
      if (
        !admitted ||
        records.some((record) => record.source_id !== admitted.source_id) ||
        admitted.commit_oid !== group.commit
      )
        throw new Error("Saved preview cleanup source identity does not match its admitted run.");
      normalized.push(group);
      continue;
    }
    const sources = new Map<string, PreviewGroup>();
    for (const record of records) {
      if (!record.timeline_slug)
        throw new Error("Saved preview cleanup lost its timeline identity.");
      const key = `${record.source_id}\0${record.timeline_slug}`;
      const split = sources.get(key) ?? {
        ...group,
        timeline: record.timeline_slug,
        deployments: [],
      };
      split.deployments.push(record.id);
      split.commit = record.commit_oid;
      split.checkpoint = record.checkpoint_id;
      sources.set(key, split);
    }
    normalized.push(...sources.values());
  }
  previews.groups = normalized;
  const live = await kdb
    .selectFrom("deployments")
    .select(["id", "source_id", "timeline_slug", "commit_oid", "checkpoint_id"])
    .where("repo_id", "=", repoId)
    .where("status", "in", ["active", "sleeping"])
    .where("timeline_slug", "is not", null)
    .orderBy("id")
    .execute();
  // Recorded by an earlier attempt that crashed before claiming them.
  const known = new Set(previews.groups.flatMap((group) => group.deployments));
  const fresh = new Map<string, PreviewGroup>();
  for (const deployment of live) {
    if (known.has(deployment.id)) continue;
    const timeline = deployment.timeline_slug!;
    const key = `${deployment.source_id}\0${timeline}`;
    const group = fresh.get(key) ?? {
      timeline,
      deployments: [],
      commit: deployment.commit_oid,
      checkpoint: deployment.checkpoint_id,
      run: null,
      skipped: null,
    };
    group.deployments.push(deployment.id);
    // The newest preview's commit and checkpoint, as the sweep does.
    group.commit = deployment.commit_oid;
    group.checkpoint = deployment.checkpoint_id;
    fresh.set(key, group);
  }
  previews.groups.push(...fresh.values());
  await saveProgress(env, repoId, { previews });
  if (live.length) {
    const at = nowIso();
    await kdb
      .updateTable("deployments")
      .set({ status: "expired", torn_down_at: at, updated_at: at })
      .where(
        "id",
        "in",
        live.map((d) => d.id),
      )
      .where("status", "in", ["active", "sleeping"])
      .execute();
  }
  const repo = await kdb
    .selectFrom("repos")
    .select(["id", "artifacts_name", "artifacts_remote", "default_branch"])
    .where("id", "=", repoId)
    .executeTakeFirst();
  let runs = 0;
  for (const group of previews.groups) {
    if (group.run || group.skipped) continue;
    if (!repo) {
      group.skipped = "The repository is gone.";
      continue;
    }
    const parent = await kdb
      .selectFrom("deployments")
      .select(["id", "source_id"])
      .where("repo_id", "=", repoId)
      .where("id", "in", group.deployments)
      .orderBy("id", "desc")
      .executeTakeFirstOrThrow();
    const sourceRepo = { ...repo, source_id: parent.source_id };
    const [started] = await startPreviewRuns(
      env,
      [
        {
          repo: sourceRepo,
          commit: group.commit,
          branch: await previewBranch(env, sourceRepo, group.timeline),
          preview: {
            action: "teardown",
            timeline: group.timeline,
            checkpoint: group.checkpoint,
            teardownOf: parent.id,
          },
        },
      ],
      null,
      waitUntil,
    );
    if (started && "number" in started) {
      group.run = { id: started.runId, number: started.number };
      runs++;
      await kdb
        .updateTable("deployments")
        .set({ teardown_run_id: started.runId })
        .where("id", "in", group.deployments)
        .execute();
    } else {
      group.skipped = started?.skipped ?? "No run was started.";
      if (started?.teardownUnmanaged)
        await kdb
          .updateTable("deployments")
          .set({ teardown_unmanaged_at: nowIso() })
          .where("id", "in", group.deployments)
          .where("teardown_run_id", "is", null)
          .execute();
    }
    await saveProgress(env, repoId, { previews });
  }
  return { groups: previews.groups.length, runs };
}

/** Teardown runs still going, and whether the purge has waited long enough. */
async function openTeardowns(
  env: Env,
  repoId: string,
  limits: Limits,
): Promise<{ runs: string[]; overdue: boolean }> {
  const runs = await db(env.DB)
    .selectFrom("ci_runs")
    .select("id")
    .where("repo_id", "=", repoId)
    .where("preview_action", "=", "teardown")
    .where("status", "in", ["queued", "running"])
    .execute();
  const startedAt = parseProgress((await loadDeletion(env, repoId))?.progress ?? "{}").previews
    ?.startedAt;
  const overdue = startedAt ? Date.now() - Date.parse(startedAt) > limits.teardownWaitMs : false;
  await saveProgress(env, repoId, {});
  return { runs: runs.map((r) => r.id), overdue };
}

// vectors: by the ids kg_nodes gives, then whatever the metadata filter still finds.

async function vectorsPhase(env: Env, repoId: string, step: PurgeStep, limits: Limits) {
  if (!env.VECTORS) return;
  for (let i = 0; ; i++) {
    const batch = await step.do(`vectors:${i}`, STEP, () => deleteNodeVectors(env, repoId, limits));
    if (batch.next === null) break;
  }
  await sweepRounds(step, "vectors", limits, async () => {
    const found = await sweepVectors(env, repoId);
    const progress = parseProgress((await loadDeletion(env, repoId))?.progress ?? "{}");
    const state = progress.vectors ?? { cursor: "", done: true, deleted: 0, swept: 0 };
    await saveProgress(env, repoId, {
      vectors: { ...state, swept: state.swept + found, remaining: found },
    });
    return found;
  });
}

async function deleteNodeVectors(
  env: Env,
  repoId: string,
  limits: Limits,
): Promise<{ next: string | null; deleted: number }> {
  const progress = parseProgress((await loadDeletion(env, repoId))?.progress ?? "{}");
  const state = progress.vectors ?? { cursor: "", done: false, deleted: 0, swept: 0 };
  if (state.done) return { next: null, deleted: 0 };
  const nodes = await db(env.DB)
    .selectFrom("kg_nodes")
    .select("id")
    .where("repo_id", "=", repoId)
    .where("id", ">", state.cursor)
    .orderBy("id")
    .limit(limits.nodesPerStep)
    .execute();
  const ids = await Promise.all(nodes.map((node) => vectorId(repoId, node.id)));
  for (let i = 0; i < ids.length; i += limits.vectorIdsPerCall)
    await env.VECTORS!.deleteByIds(ids.slice(i, i + limits.vectorIdsPerCall));
  const next = nodes.length === limits.nodesPerStep ? nodes.at(-1)!.id : null;
  await saveProgress(env, repoId, {
    vectors: {
      ...state,
      cursor: next ?? state.cursor,
      done: next === null,
      deleted: state.deleted + ids.length,
    },
  });
  return { next, deleted: ids.length };
}

/** A unit vector of the index's dimensions: with a metadata filter, it finds any vector. */
async function probeVector(env: Env): Promise<number[]> {
  // A V2 index answers VectorizeIndexInfo, a legacy one VectorizeIndexDetails.
  const info = (await env.VECTORS!.describe()) as Partial<VectorizeIndexInfo> &
    Partial<VectorizeIndexDetails>;
  const config = info.config as { dimensions?: number } | undefined;
  const dimensions = info.dimensions ?? config?.dimensions;
  if (!dimensions) throw new Error("Vectorize didn't say how many dimensions the index has.");
  const vector = Array.from({ length: dimensions }, () => 0);
  vector[0] = 1;
  return vector;
}

/** The ids the metadata filter finds for a repository (at most 100). */
export async function repoVectorIds(env: Env, repoId: string): Promise<string[]> {
  if (!env.VECTORS) return [];
  const matches = await env.VECTORS.query(await probeVector(env), {
    topK: 100,
    filter: { repo: repoId },
    returnValues: false,
    returnMetadata: "none",
  });
  return matches.matches.map((match) => match.id);
}

/** Delete what the metadata filter still finds; how many it found. */
export async function sweepVectors(env: Env, repoId: string): Promise<number> {
  const ids = await repoVectorIds(env, repoId);
  if (ids.length) await env.VECTORS!.deleteByIds(ids);
  return ids.length;
}

/**
 * Repeat a sweep until it finds nothing in `emptyRounds` rounds in a row,
 * waiting between rounds: both providers apply changes asynchronously, so a
 * round may still see what the last one deleted, and a query answered from a
 * replica that hasn't caught up may miss what is there.
 */
async function sweepRounds(
  step: PurgeStep,
  name: string,
  limits: Limits,
  sweep: () => Promise<number>,
) {
  let empty = 0;
  for (let i = 0; i < limits.sweepRounds; i++) {
    const found = await step.do(`${name}:sweep:${i}`, STEP, sweep);
    empty = found ? 0 : empty + 1;
    if (empty >= limits.emptyRounds) return;
    await step.sleep(
      `${name}:sweep-wait:${i}`,
      i < limits.sweepFastRounds ? limits.sweepWait : limits.sweepSlowWait,
    );
  }
}

// search: the items kg_search_items names, then whatever still lists for the repository.

async function searchPhase(env: Env, repoId: string, step: PurgeStep, limits: Limits) {
  if (!env.SEARCH) return;
  for (let i = 0; ; i++) {
    const batch = await step.do(`search:${i}`, STEP, () => deleteSearchRows(env, repoId, limits));
    if (!batch.more) break;
  }
  await sweepRounds(step, "search", limits, async () => {
    const found = await sweepSearch(env, repoId, limits);
    const progress = parseProgress((await loadDeletion(env, repoId))?.progress ?? "{}");
    await saveProgress(env, repoId, {
      search: {
        deleted: progress.search?.deleted ?? 0,
        swept: (progress.search?.swept ?? 0) + found,
        remaining: found,
      },
    });
    return found;
  });
}

function searchItems(env: Env) {
  return env.SEARCH!.get(SEARCH_INSTANCE).items;
}

async function deleteSearchRows(
  env: Env,
  repoId: string,
  limits: Limits,
): Promise<{ deleted: number; more: boolean }> {
  const rows = await db(env.DB)
    .selectFrom("kg_search_items")
    .select(["key", "item_id"])
    .where("repo_id", "=", repoId)
    .orderBy("key")
    .limit(limits.itemsPerStep)
    .execute();
  const items = searchItems(env);
  await pool(rows, limits.itemConcurrency, async (row) => {
    await items.delete(row.item_id).catch((error: unknown) => {
      if (!notFound(error)) throw error;
    });
  });
  for (const row of rows)
    await db(env.DB)
      .deleteFrom("kg_search_items")
      .where("repo_id", "=", repoId)
      .where("key", "=", row.key)
      .execute();
  const progress = parseProgress((await loadDeletion(env, repoId))?.progress ?? "{}");
  await saveProgress(env, repoId, {
    search: {
      deleted: (progress.search?.deleted ?? 0) + rows.length,
      swept: progress.search?.swept ?? 0,
    },
  });
  return { deleted: rows.length, more: rows.length === limits.itemsPerStep };
}

function notFound(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /not.?found|404/i.test(text);
}

/** A repository's items still listed (not already being deleted), by metadata or name. */
export async function repoSearchItems(
  env: Env,
  repoId: string,
  perPage = 50,
): Promise<AiSearchItemInfo[]> {
  if (!env.SEARCH) return [];
  const items = searchItems(env);
  // By metadata and by name: either finds an item the other's index misses.
  const lists = await Promise.allSettled([
    items.list({ metadata_filter: JSON.stringify({ repo: repoId }), per_page: perPage }),
    items.list({ search: `${repoId}/`, per_page: perPage }),
  ]);
  const listed = lists.flatMap((list) => (list.status === "fulfilled" ? list.value.result : []));
  if (lists.every((list) => list.status === "rejected"))
    throw (lists[0] as PromiseRejectedResult).reason;
  const found = new Map<string, AiSearchItemInfo>();
  for (const item of listed)
    if (
      (item.metadata?.repo === repoId || item.key.startsWith(`${repoId}/`)) &&
      item.next_action !== "DELETE"
    )
      found.set(item.id, item);
  return [...found.values()];
}

/** Delete what still lists for the repository; how many it found. */
export async function sweepSearch(env: Env, repoId: string, limits: Limits): Promise<number> {
  const found = await repoSearchItems(env, repoId);
  const items = searchItems(env);
  await pool(found, limits.itemConcurrency, async (item) => {
    await items.delete(item.id).catch((error: unknown) => {
      if (!notFound(error)) throw error;
    });
  });
  return found.length;
}

// durable: every registered instance the repository owns.

async function durablePhase(env: Env, repoId: string, step: PurgeStep, limits: Limits) {
  for (let i = 0; ; i++) {
    const batch = await step.do(`durable:${i}`, STEP, () => purgeOwned(env, repoId, limits));
    if (!batch.more) break;
  }
}

async function purgeOwned(env: Env, repoId: string, limits: Limits) {
  const { results } = await env.DB.prepare(
    `SELECT class, name FROM do_instances
      WHERE purged_at IS NULL
        AND (repo_id = ?1
          OR (class = 'KnowledgeCoordinator' AND name = ?1)
          OR (class = 'CiSandbox' AND name IN (SELECT id FROM ci_jobs WHERE repo_id = ?1)))
      ORDER BY class, name LIMIT ?2`,
  )
    .bind(repoId, limits.instancesPerStep)
    .all<{ class: DurableClass; name: string }>();
  let purged = 0;
  let failed = 0;
  for (const row of results) {
    if (!Reflect.get(env, bindingOf(row.class))) {
      failed++;
      continue;
    }
    await purgeInstance(env, row.class, row.name, "repository deleted");
    purged++;
  }
  const progress = parseProgress((await loadDeletion(env, repoId))?.progress ?? "{}");
  await saveProgress(env, repoId, {
    durable: {
      purged: (progress.durable?.purged ?? 0) + purged,
      failed: (progress.durable?.failed ?? 0) + failed,
    },
  });
  // An instance whose class isn't bound here can't be purged: don't loop on it.
  return { more: results.length === limits.instancesPerStep && purged > 0 };
}

function bindingOf(cls: DurableClass): string {
  return DURABLE_CLASSES[cls]?.binding ?? "";
}

// links: what other tables and the registry say about the repository.

async function linksPhase(env: Env, repoId: string, step: PurgeStep, limits: Limits) {
  const spend = await step.do("links:spend", STEP, () => unlinkSpend(env, repoId));
  let publishes = 0;
  for (let i = 0; ; i++) {
    const batch = await step.do(`links:publishes:${i}`, STEP, () =>
      unlinkPublishes(env, repoId, limits),
    );
    publishes += batch.unlinked;
    if (!batch.more) break;
  }
  const sources = await step.do("links:sources", STEP, async () => {
    const result = await env.REGISTRY_DB.prepare(
      "DELETE FROM package_sources WHERE git_repo_id = ?",
    )
      .bind(repoId)
      .run();
    return result.meta.changes ?? 0;
  });
  await step.do("links:record", STEP, () =>
    saveProgress(env, repoId, { links: { ...spend, sources, publishes } }),
  );
}

/**
 * Atlas spend: earlier days' rows go; today's stay, detached from the
 * repository, because they still count against the account's daily ceiling.
 * The build-scoped budget markers of its builds go.
 */
async function unlinkSpend(env: Env, repoId: string) {
  const today = nowIso().slice(0, 10);
  const [deleted, exhaustions, detached] = await env.DB.batch([
    env.DB.prepare("DELETE FROM atlas_spend WHERE repo_id = ?1 AND day < ?2").bind(repoId, today),
    env.DB.prepare(
      `DELETE FROM atlas_budget_exhaustions
        WHERE scope = 'build' AND run_id IN (SELECT id FROM kg_builds WHERE repo_id = ?1)`,
    ).bind(repoId),
    env.DB.prepare("UPDATE atlas_spend SET repo_id = NULL WHERE repo_id = ?1").bind(repoId),
  ]);
  return {
    spendDeleted: deleted?.meta.changes ?? 0,
    exhaustions: exhaustions?.meta.changes ?? 0,
    spendDetached: detached?.meta.changes ?? 0,
  };
}

/** A publish keeps its package's history, without the repository, commit or run it came from. */
async function unlinkPublishes(env: Env, repoId: string, limits: Limits) {
  const result = await env.REGISTRY_DB.prepare(
    `UPDATE publishes
        SET git_repo_id = NULL, commit_oid = NULL, ref = NULL, ci_run_id = NULL, ci_job_id = NULL, run_number = NULL
      WHERE id IN (SELECT id FROM publishes WHERE git_repo_id = ?1 LIMIT ?2)`,
  )
    .bind(repoId, limits.publishesPerStatement)
    .run();
  const unlinked = result.meta.changes ?? 0;
  return { unlinked, more: unlinked === limits.publishesPerStatement };
}

// artifacts: the git repository.

async function artifactsPhase(env: Env, repoId: string, step: PurgeStep) {
  // Also cover a resumed purge and teardown consumers admitted after stop.
  await step.do("artifacts:ci-acknowledged", STEP, () => assertCiDrained(env, repoId, false));
  await step.do("artifacts:work-sources", STEP, () => drainDeletedRepoSources(env, repoId));
  await step.do("artifacts:delete", STEP, async () => {
    const row = await loadDeletion(env, repoId);
    const name = row?.artifacts_name;
    if (!name) return;
    forgetUpstreamTokens(name);
    // False when it's already gone: deleting again is fine.
    await env.ARTIFACTS.delete(name);
    await saveProgress(env, repoId, { artifacts: { deleted: true } });
  });
}

// rows: the biggest children in bounded batches, then the row and its cascade.

/** Large child tables, children before parents, with how a row finds the repository (?1). */
export const CHILD_ROWS: [table: string, where: string][] = [
  ["timeline_source_roots", "repo_id = ?1"],
  ["source_integration_members", "repo_id = ?1"],
  ["source_integration_inputs", "repo_id = ?1"],
  ["source_integration_receipts", "repo_id = ?1"],
  ["source_progress_members", "repo_id = ?1"],
  ["source_revision_origins", "repo_id = ?1"],
  ["source_operations", "repo_id = ?1"],
  ["timeline_work_sources", "repo_id = ?1 AND state = 'purged'"],
  ["merge_queue", "repo_id = ?1"],
  ["ci_logs", "job_id IN (SELECT id FROM ci_jobs WHERE repo_id = ?1)"],
  ["ci_steps", "job_id IN (SELECT id FROM ci_jobs WHERE repo_id = ?1)"],
  ["ci_jobs", "repo_id = ?1"],
  ["deployments", "repo_id = ?1"],
  ["ci_runs", "repo_id = ?1"],
  ["kg_edges", "repo_id = ?1"],
  ["kg_nodes", "repo_id = ?1"],
  ["kg_files", "repo_id = ?1"],
  ["kg_changes", "repo_id = ?1"],
  ["kg_overlay_changes", "repo_id = ?1"],
  ["kg_search_items", "repo_id = ?1"],
  ["wiki_pages", "repo_id = ?1"],
  ["atlas_edges", "scope IN (SELECT scope FROM atlas_scopes WHERE repo_id = ?1)"],
  ["atlas_entities", "scope IN (SELECT scope FROM atlas_scopes WHERE repo_id = ?1)"],
  ["change_refs", "repo_id = ?1"],
  ["ref_updates", "repo_id = ?1"],
  ["release_note_entries", "repo_id = ?1"],
];

async function rowsPhase(env: Env, repoId: string, step: PurgeStep, limits: Limits) {
  for (let i = 0; ; i++) {
    const batch = await step.do(`rows:${i}`, STEP, () => deleteChildren(env, repoId, limits));
    if (!batch.more) break;
  }
  await step.do("rows:repository", STEP, async () => {
    // Only a tombstoned row: never a namesake created after the purge.
    // RETURNING counts the row itself; D1's `changes` would add its cascade.
    const { results } = await env.DB.prepare(
      "DELETE FROM repos WHERE id = ?1 AND deleted_at IS NOT NULL RETURNING id",
    )
      .bind(repoId)
      .all();
    const progress = parseProgress((await loadDeletion(env, repoId))?.progress ?? "{}");
    await saveProgress(env, repoId, {
      rows: { ...progress.rows, repos: (progress.rows?.repos ?? 0) + results.length },
    });
  });
}

async function deleteChildren(env: Env, repoId: string, limits: Limits) {
  const progress = parseProgress((await loadDeletion(env, repoId))?.progress ?? "{}");
  const counts = { ...progress.rows };
  let statements = 0;
  let more = false;
  for (const [table, where] of CHILD_ROWS) {
    for (;;) {
      if (statements >= limits.statementsPerStep) {
        more = true;
        break;
      }
      statements++;
      // RETURNING counts this table's rows only (D1's `changes` includes cascades).
      const { results } = await env.DB.prepare(
        `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ?2) RETURNING 1 AS gone`,
      )
        .bind(repoId, limits.rowsPerStatement)
        .all();
      const changes = results.length;
      if (changes) counts[table] = (counts[table] ?? 0) + changes;
      if (changes < limits.rowsPerStatement) break;
    }
    if (more) break;
  }
  await saveProgress(env, repoId, { rows: counts });
  return { more };
}

// ---- reading ---------------------------------------------------------------

/** A deletion as the API and E2E see it. */
export async function deletionStatus(env: Env, repoId: string) {
  const row = await loadDeletion(env, repoId);
  if (!row) return null;
  return {
    repoId: row.repo_id,
    fullName: row.full_name,
    source: row.source,
    phase: row.phase as Phase,
    progress: parseProgress(row.progress),
    workflowId: row.workflow_id,
    attempts: row.attempts,
    finishedAt: row.finished_at,
  };
}
