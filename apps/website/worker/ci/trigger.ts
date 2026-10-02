// Starting runs. After every push through the proxy, onPush() compares the
// repository's branches with the ones CI last saw (ci_refs); each branch that
// moved gets a run of the pipeline in .gitmatrix/ci.yml at its new commit.
// Runs can also be started by hand for any branch.

import type { InferResult } from "kysely";
import { listRefs } from "../artifacts.ts";
import { RepoReader } from "../objects.ts";
import { batch, db, nowIso } from "../schema.ts";
import { Timing } from "../timing.ts";
import {
  branchMatches,
  CONFIG_PATH,
  ConfigError,
  evaluate,
  parsePipeline,
  type Pipeline,
} from "./config.ts";
import type { StoredJob } from "./jobs.ts";

export interface CiRepo {
  id: string;
  artifacts_name: string;
  artifacts_remote: string;
}

export interface RunParams {
  runId: string;
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

/** Record a run and its jobs, then start its Workflow. Returns the run id. */
export async function startRun(
  env: Env,
  repo: CiRepo,
  options: {
    branch: string;
    commit: string;
    trigger: "push" | "manual";
    actorId: string | null;
    waitUntil: Waiter;
  },
): Promise<{ runId: string; number: number } | { skipped: string }> {
  const reader = new RepoReader(
    env,
    repo.artifacts_name,
    repo.artifacts_remote,
    new Timing(),
    options.waitUntil,
  );
  try {
    const found = await pipelineAt(reader, options.commit);
    if (!found) return { skipped: `No ${CONFIG_PATH} at ${options.commit.slice(0, 12)}.` };
    const { pipeline, error, title } = found;
    if (
      pipeline &&
      options.trigger === "push" &&
      !branchMatches(options.branch, pipeline.branches)
    ) {
      return { skipped: `${options.branch} is not in on.push.branches.` };
    }

    const runId = crypto.randomUUID().replaceAll("-", "");
    const context = {
      branch: options.branch,
      trigger: options.trigger,
      commit: options.commit,
      runner: env.CI_RUNNER,
    };
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
          "title",
          "status",
          "config_error",
          "finished_at",
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
              eb.val(options.trigger).as("trigger"),
              eb.val(options.actorId).as("actor_id"),
              eb.val(title).as("title"),
              eb.val(error ? "failed" : "queued").as("status"),
              eb.val(error).as("config_error"),
              eb.val(error === null ? null : nowIso()).as("finished_at"),
            ])
            .where("repo_id", "=", repo.id),
        ),
    ];
    for (const job of pipeline?.jobs ?? []) {
      const jobId = crypto.randomUUID().replaceAll("-", "");
      const run = job.if === null || evaluate(job.if, context);
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
      };
      statements.push(
        kdb.insertInto("ci_jobs").values({
          id: jobId,
          run_id: runId,
          repo_id: repo.id,
          name: job.name,
          spec: JSON.stringify(spec),
          status: run ? "pending" : "skipped",
          runner: env.CI_RUNNER,
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
    if (!error) {
      try {
        await env.CI_RUN.create({ id: runId, params: { runId } satisfies RunParams });
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
export async function onPush(env: Env, repo: CiRepo, actorId: string | null, waitUntil: Waiter) {
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
    try {
      await startRun(env, repo, {
        branch: row.ref,
        commit: row.oid,
        trigger: "push",
        actorId,
        waitUntil,
      });
    } catch (error) {
      console.error("CI: could not start a run", { repo: repo.id, ref: row.ref, error });
    }
  }
}
