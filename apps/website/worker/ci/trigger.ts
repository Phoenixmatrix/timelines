// Starting runs. After every push through the proxy, onPush() compares the
// repository's branches with the ones CI last saw (ci_refs); each branch that
// moved gets a run of the pipeline in .gitmatrix/ci.yml at its new commit.
// Runs can also be started by hand for any branch, and Gitmatrix starts
// preview runs for projects that opt in with `on: preview` (CORE-79,
// worker/deployments/previews.ts).

import type { InferResult } from "kysely";
import { listRefs } from "../artifacts.ts";
import type { Actor } from "../db.ts";
import { RepoReader } from "../objects.ts";
import { batch, db, nowIso } from "../schema.ts";
import { Timing } from "../timing.ts";
import {
  branchMatches,
  CONFIG_PATH,
  ConfigError,
  jobRuns,
  parsePipeline,
  type Pipeline,
} from "./config.ts";
import { activeRun, anyHeld, inFlight, lastPassed, releaseHeld, UNCHANGED } from "./coalesce.ts";
import type { StoredJob } from "./jobs.ts";
import { landingSlugOf } from "../../shared/timelines.ts";

export interface CiRepo {
  id: string;
  artifacts_name: string;
  artifacts_remote: string;
}

export interface RunParams {
  runId: string;
}

/** What a preview run (trigger "preview") is for. */
export interface PreviewRun {
  action: "create" | "teardown";
  /** The timeline's slug. */
  timeline: string;
  checkpoint: string | null;
  /** A `create` that revives a checkpoint's preview: what it records is marked rebuilt. */
  revived?: boolean;
  /** The record the revival stands in for, when there was one. */
  rebuiltFrom?: number | null;
}

type Waiter = (work: Promise<unknown>) => void;

/** Read and parse the pipeline at a commit: null when there is none. */
async function pipelineAt(
  reader: RepoReader,
  commit: string,
): Promise<{ pipeline: Pipeline | null; error: string | null; title: string } | null> {
  const meta = await reader.commit(commit);
  if (!meta) return null;
  const title = meta.message.split("\n")[0]?.slice(0, 200) ?? "";
  const entry = await reader.entryAt(meta.treeHash, CONFIG_PATH);
  if (!entry || entry.type === "tree") return null;
  const blob = await reader.blob(entry.hash);
  if (!blob) return null;
  try {
    return { pipeline: parsePipeline(new TextDecoder().decode(blob.bytes)), error: null, title };
  } catch (error) {
    if (error instanceof ConfigError) return { pipeline: null, error: error.message, title };
    throw error;
  }
}

/** Start a recorded run's Workflow. */
export async function startWorkflow(env: Env, runId: string) {
  await env.CI_RUN.create({ id: runId, params: { runId } satisfies RunParams });
}

/** Record a run and its jobs, then start its Workflow. Returns the run id. */
export async function startRun(
  env: Env,
  repo: CiRepo,
  options: {
    branch: string;
    commit: string;
    /**
     * `landing`: the gates on a landing's merge (CORE-77). Jobs see
     * `trigger == "landing"`; the run is stored as manual with its landing
     * (`landing_id`), as previews are.
     */
    trigger: "push" | "manual" | "preview" | "landing";
    /** With trigger "preview": its action, timeline and checkpoint. */
    preview?: PreviewRun;
    /** With trigger "landing": the landing whose merge it tests. */
    landingId?: string;
    /** Who pushed or started it: a person, or an agent acting for one. */
    actor: Pick<Actor, "id" | "agent"> | null;
    waitUntil: Waiter;
    /** The run's id, when the caller recorded it before starting it (a landing does). */
    runId?: string;
  },
): Promise<{ runId: string; number: number } | { skipped: string }> {
  const preview = options.trigger === "preview" ? (options.preview ?? null) : null;
  if (options.trigger === "preview" && !preview)
    throw new Error("A preview run needs its action and timeline.");
  const reader = new RepoReader(
    env,
    repo.artifacts_name,
    repo.artifacts_remote,
    new Timing(),
    options.waitUntil,
  );
  try {
    // A run of this commit already in flight on the branch answers for it.
    const existing = await activeRun(
      env.DB,
      repo.id,
      options.branch,
      options.commit,
      preview && { action: preview.action, checkpoint: preview.checkpoint },
    );
    if (existing) return { runId: existing.id, number: existing.number };
    const found = await pipelineAt(reader, options.commit);
    if (!found) return { skipped: `No ${CONFIG_PATH} at ${options.commit.slice(0, 12)}.` };
    const { pipeline, error, title } = found;
    // Previews are opt-in, and a broken ci.yml already failed the push's run.
    if (preview && !pipeline)
      return { skipped: `${CONFIG_PATH} at ${options.commit.slice(0, 12)} has errors: ${error}` };
    if (preview && !pipeline?.preview)
      return {
        skipped: `${CONFIG_PATH} at ${options.commit.slice(0, 12)} doesn't opt in to previews (on: preview).`,
      };
    if (
      pipeline &&
      options.trigger === "push" &&
      !branchMatches(options.branch, pipeline.branches)
    ) {
      return { skipped: `${options.branch} is not in on.push.branches.` };
    }

    const runId = options.runId ?? crypto.randomUUID().replaceAll("-", "");
    const stored =
      options.trigger === "preview" || options.trigger === "landing" ? "manual" : options.trigger;
    const context = {
      branch: options.branch,
      trigger: options.trigger,
      commit: options.commit,
      runner: env.CI_RUNNER,
      action: preview?.action ?? "",
    };
    // A project may opt in and handle only one action: no run for the other.
    if (preview && !pipeline!.jobs.some((job) => jobRuns(job, context)))
      return { skipped: `No job in ${CONFIG_PATH} runs for preview ${preview.action}.` };
    const kdb = db(env.DB);
    const statements: Parameters<typeof batch>[1] = [
      kdb
        .insertInto("ci_runs")
        .columns([
          "id",
          "repo_id",
          "number",
          "commit_oid",
          "ref",
          "trigger",
          "actor_id",
          "agent_id",
          "title",
          "status",
          "config_error",
          "finished_at",
          "preview_action",
          "timeline_slug",
          "checkpoint_id",
          "preview_revived",
          "preview_rebuilt_from",
          "landing_id",
        ])
        .expression((eb) =>
          eb
            .selectFrom("ci_runs")
            .select([
              eb.val(runId).as("id"),
              eb.val(repo.id).as("repo_id"),
              eb(eb.fn.coalesce(eb.fn.max("number"), eb.lit(0)), "+", eb.lit(1)).as("number"),
              eb.val(options.commit).as("commit_oid"),
              eb.val(options.branch).as("ref"),
              // ci_runs.trigger's CHECK predates previews and landings: see the migrations.
              eb.val(stored).as("trigger"),
              eb.val(options.actor?.id ?? null).as("actor_id"),
              eb.val(options.actor?.agent?.id ?? null).as("agent_id"),
              eb.val(title).as("title"),
              eb.val(error ? "failed" : "queued").as("status"),
              eb.val(error).as("config_error"),
              eb.val(error === null ? null : nowIso()).as("finished_at"),
              eb.val(preview?.action ?? null).as("preview_action"),
              eb.val(preview?.timeline ?? null).as("timeline_slug"),
              eb.val(preview?.checkpoint ?? null).as("checkpoint_id"),
              eb.val(preview?.revived ? 1 : 0).as("preview_revived"),
              eb.val(preview?.rebuiltFrom ?? null).as("preview_rebuilt_from"),
              eb
                .val(options.trigger === "landing" ? (options.landingId ?? null) : null)
                .as("landing_id"),
            ])
            .where("repo_id", "=", repo.id),
        ),
    ];
    const tree = (await reader.commit(options.commit))?.treeHash;
    for (const job of pipeline?.jobs ?? []) {
      const jobId = crypto.randomUUID().replaceAll("-", "");
      let run = jobRuns(job, context);
      let unchanged: string | null = null;
      const spec: StoredJob = {
        needs: job.needs,
        if: job.if,
        image: job.image,
        instance: job.instance,
        env: { ...pipeline!.env, ...job.env },
        secrets: job.secrets,
        timeoutMinutes: job.timeoutMinutes,
        steps: job.steps,
        concurrency: job.concurrency ?? null,
        paths: job.paths ?? [],
      };
      // On a push, a job whose paths match the last commit it passed on is skipped.
      if (run && options.trigger === "push" && spec.paths?.length && tree) {
        const base = await lastPassed(
          env.DB,
          repo.id,
          options.branch,
          job.name,
          JSON.stringify(spec),
        );
        const baseTree = base && (await reader.commit(base.commit))?.treeHash;
        if (base && baseTree) {
          const same = await Promise.all(
            spec.paths.map(async (path) => {
              const [before, after] = await Promise.all([
                reader.entryAt(baseTree, path),
                reader.entryAt(tree, path),
              ]);
              return (before?.hash ?? null) === (after?.hash ?? null);
            }),
          );
          if (same.every(Boolean)) {
            run = false;
            unchanged = `${UNCHANGED}${base.number}: ${spec.paths.join(", ")} matches.`;
          }
        }
      }
      statements.push(
        kdb.insertInto("ci_jobs").values({
          id: jobId,
          run_id: runId,
          repo_id: repo.id,
          name: job.name,
          spec: JSON.stringify(spec),
          status: run ? "pending" : "skipped",
          runner: env.CI_RUNNER,
          ...(unchanged ? { error: unchanged } : {}),
        }),
        ...job.steps.map((step, position) =>
          kdb.insertInto("ci_steps").values({
            job_id: jobId,
            position,
            name: step.name,
            status: run ? "pending" : "skipped",
          }),
        ),
      );
    }
    await batch(env.DB, statements);
    // Under load, a push waits in a held run: when a run on its branch finishes,
    // the newest held run starts and covers the older ones.
    const limit = pipeline?.coalesceAfter;
    if (!error && limit && options.trigger === "push") {
      const busy = await inFlight(env.DB, repo.id, options.branch, runId);
      if (busy >= limit || (await anyHeld(env.DB, repo.id, options.branch, runId))) {
        await kdb
          .updateTable("ci_runs")
          .set({ held_at: nowIso() })
          .where("id", "=", runId)
          .execute();
        // Held runs from before can start now if there's room (say a run got stuck).
        if (busy < limit)
          await releaseHeld(env.DB, repo.id, options.branch, (id) => startWorkflow(env, id));
        const held = await kdb
          .selectFrom("ci_runs")
          .select("number")
          .where("id", "=", runId)
          .executeTakeFirst();
        return { runId, number: held?.number ?? 0 };
      }
    }
    if (!error) {
      try {
        await startWorkflow(env, runId);
      } catch (cause) {
        // Without its Workflow nothing would ever move the run on: fail it now.
        await kdb
          .updateTable("ci_runs")
          .set({
            status: "failed",
            config_error: `The run could not be started: ${String(cause)}`,
            finished_at: nowIso(),
          })
          .where("id", "=", runId)
          .execute();
        throw cause;
      }
    }
    const row = await kdb
      .selectFrom("ci_runs")
      .select("number")
      .where("id", "=", runId)
      .executeTakeFirst();
    return { runId, number: row?.number ?? 0 };
  } finally {
    await reader.close();
  }
}

/**
 * After a push: start a run for every branch that moved. The upsert is
 * conditional, so concurrent pushes (or retries) never start the same run twice.
 */
export async function onPush(
  env: Env,
  repo: CiRepo,
  actor: Pick<Actor, "id" | "agent"> | null,
  waitUntil: Waiter,
) {
  const refs = await listRefs(env, repo.artifacts_name, repo.artifacts_remote);
  const kdb = db(env.DB);
  const known = new Set(
    (await kdb.selectFrom("ci_refs").select("ref").where("repo_id", "=", repo.id).execute()).map(
      (r) => r.ref,
    ),
  );
  const upserts = refs.branches.map((branch) =>
    kdb
      .insertInto("ci_refs")
      .values({ repo_id: repo.id, ref: branch.shortName, oid: branch.oid })
      .onConflict((oc) =>
        oc
          .columns(["repo_id", "ref"])
          .doUpdateSet((eb) => ({ oid: eb.ref("excluded.oid") }))
          .where("ci_refs.oid", "!=", (eb) => eb.ref("excluded.oid")),
      )
      .returning(["ref", "oid"]),
  );
  const moved = await batch(env.DB, upserts);
  const current = new Set(refs.branches.map((b) => b.shortName));
  const gone = [...known].filter((ref) => !current.has(ref));
  if (gone.length) {
    await batch(
      env.DB,
      gone.map((ref) =>
        kdb.deleteFrom("ci_refs").where("repo_id", "=", repo.id).where("ref", "=", ref),
      ),
    );
  }

  for (const result of moved) {
    const row = (result.results as InferResult<(typeof upserts)[number]>)[0];
    if (!row) continue;
    // The first time CI sees a repository, every branch looks new; only the
    // default branch gets a run then.
    if (known.size === 0 && row.ref !== refs.headBranch) continue;
    // A landing's merge is tested by the landing itself (timelines/landing.ts).
    if (landingSlugOf(row.ref)) continue;
    try {
      await startRun(env, repo, {
        branch: row.ref,
        commit: row.oid,
        trigger: "push",
        actor,
        waitUntil,
      });
    } catch (error) {
      console.error("CI: could not start a run", { repo: repo.id, ref: row.ref, error });
    }
  }
}
