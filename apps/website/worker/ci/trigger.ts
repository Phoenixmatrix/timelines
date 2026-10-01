// Starting runs. After every push through the proxy, onPush() compares the
// repository's branches with the ones CI last saw (ci_refs); each branch that
// moved gets a run of the pipeline in .gitmatrix/ci.yml at its new commit.
// Runs can also be started by hand for any branch.

import { listRefs } from "../artifacts.ts";
import { RepoReader } from "../objects.ts";
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
    const context = { branch: options.branch, trigger: options.trigger, commit: options.commit };
    const statements: D1PreparedStatement[] = [
      env.DB.prepare(
        `INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, actor_id, title, status, config_error, finished_at)
         SELECT ?1, ?2, COALESCE(MAX(number), 0) + 1, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
           CASE WHEN ?9 IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END
         FROM ci_runs WHERE repo_id = ?2`,
      ).bind(
        runId,
        repo.id,
        options.commit,
        options.branch,
        options.trigger,
        options.actorId,
        title,
        error ? "failed" : "queued",
        error,
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
      };
      statements.push(
        env.DB.prepare(
          `INSERT INTO ci_jobs (id, run_id, repo_id, name, spec, status, runner) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          jobId,
          runId,
          repo.id,
          job.name,
          JSON.stringify(spec),
          run ? "pending" : "skipped",
          env.CI_RUNNER,
        ),
        ...job.steps.map((step, position) =>
          env.DB.prepare(
            `INSERT INTO ci_steps (job_id, position, name, status) VALUES (?, ?, ?, ?)`,
          ).bind(jobId, position, step.name, run ? "pending" : "skipped"),
        ),
      );
    }
    await env.DB.batch(statements);
    if (!error) {
      try {
        await env.CI_RUN.create({ id: runId, params: { runId } satisfies RunParams });
      } catch (cause) {
        // Without its Workflow nothing would ever move the run on: fail it now.
        await env.DB.prepare(
          `UPDATE ci_runs SET status = 'failed', config_error = ?,
             finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
        )
          .bind(`The run could not be started: ${String(cause)}`, runId)
          .run();
        throw cause;
      }
    }
    const number = await env.DB.prepare("SELECT number FROM ci_runs WHERE id = ?")
      .bind(runId)
      .first<number>("number");
    return { runId, number: number ?? 0 };
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
  const known = new Set(
    (
      await env.DB.prepare("SELECT ref FROM ci_refs WHERE repo_id = ?")
        .bind(repo.id)
        .all<{ ref: string }>()
    ).results.map((r) => r.ref),
  );
  const moved = await env.DB.batch(
    refs.branches.map((branch) =>
      env.DB.prepare(
        `INSERT INTO ci_refs (repo_id, ref, oid) VALUES (?, ?, ?)
         ON CONFLICT (repo_id, ref) DO UPDATE SET oid = excluded.oid WHERE ci_refs.oid != excluded.oid
         RETURNING ref, oid`,
      ).bind(repo.id, branch.shortName, branch.oid),
    ),
  );
  const current = new Set(refs.branches.map((b) => b.shortName));
  const gone = [...known].filter((ref) => !current.has(ref));
  if (gone.length) {
    await env.DB.batch(
      gone.map((ref) =>
        env.DB.prepare("DELETE FROM ci_refs WHERE repo_id = ? AND ref = ?").bind(repo.id, ref),
      ),
    );
  }

  for (const result of moved) {
    const row = (result.results as { ref: string; oid: string }[])[0];
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
