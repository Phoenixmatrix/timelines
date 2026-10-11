// Running a CI job on Cloudflare Sandbox. One Durable Object per job owns one
// container (ctx.container, image from ci/Dockerfile): start it, clone the
// commit straight from Artifacts with a short-lived read token, run each step
// with bash, stream output into D1, then destroy the container so nothing
// idles on the bill.

import { DurableObject } from "cloudflare:workers";
import type { CiClaimedJob, CiJobReport } from "../../shared/api.ts";
import { upstreamToken } from "../artifacts.ts";
import { batch, db, nowIso } from "../schema.ts";
import { jobPayload, loadJob, report, type StoredJob } from "./jobs.ts";
import { mintJobToken, revokeJobTokens, withConfigDir } from "./registry.ts";
import {
  clearStorage,
  pendingRetirement,
  resetSoon,
  scheduleRetirement,
  settleRetirement,
  storageReport,
  type Purgeable,
  type PurgeReport,
} from "../durable/contract.ts";
import { durableStub } from "../durable/registry.ts";
import { ciSource } from "./source.ts";
import { executionIdentity } from "./verification.ts";

const WORKDIR = "/workspace/repo";
/** Package tools' configuration (npmrc, docker/config.json…), outside the checkout. */
const CONFIG_DIR = "/root/.gitmatrix-ci";
const BASE_ENV = {
  HOME: "/root",
  // The checkout's own tools first: once installed, `vp` is the repository's
  // pinned Vite+, which refuses to run under a different global version.
  PATH: "/workspace/repo/node_modules/.bin:/usr/local/pnpm/bin:/usr/local/pnpm:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  RUSTUP_HOME: "/usr/local/rustup",
  CARGO_HOME: "/usr/local/cargo",
  PNPM_HOME: "/usr/local/pnpm",
};
const FLUSH_MS = 1000;
const FLUSH_BYTES = 16 * 1024;
const READY_TIMEOUT_MS = 180_000;
/** A container that still isn't running after this long is asked to start again. */
const RESTART_AFTER_MS = 10_000;
/** Log lines before step 0 (start-up and checkout) are filed under this step. */
export const SETUP_STEP = -1;

class Cancelled extends Error {}

const FINISHED = new Set(["succeeded", "failed", "cancelled", "skipped"]);

export class CiSandbox extends DurableObject<Env> implements Purgeable {
  #running: Promise<void> | null = null;

  /** Read platform version/image metadata without starting a container. */
  verificationIdentity(): string | null {
    return executionIdentity(
      this.ctx.container?.images.default,
      Reflect.get(this.env, "CI_VERSION"),
    );
  }

  /**
   * Run the job, once. Workflows replay a step whose invocation ended while it
   * was in flight, so a second call joins the run in progress, and a call for
   * a job that already finished returns at once instead of starting it over.
   */
  run(jobId: string): Promise<void> {
    this.#running ??= this.#run(jobId).finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  // The purge contract (worker/durable/contract.ts, CORE-197): the container
  // is the external resource; the object keeps no storage of its own.
  async purge(reason: string): Promise<PurgeReport> {
    const report = await this.#clear(reason);
    resetSoon(this.ctx);
    return report;
  }

  async #clear(reason: string): Promise<PurgeReport> {
    const container = this.ctx.container;
    if (container?.running) await container.destroy();
    return clearStorage(this.ctx.storage, reason);
  }

  /** Purge once the job in progress (if any) has ended. */
  retire(reason: string, name: string, delayMs?: number): Promise<void> {
    return scheduleRetirement(this.ctx.storage, reason, name, delayMs);
  }

  storageReport() {
    return storageReport(this.ctx.storage);
  }

  override async alarm(): Promise<void> {
    const retirement = await pendingRetirement(this.ctx.storage);
    if (!retirement) return;
    await settleRetirement({
      storage: this.ctx.storage,
      env: this.env,
      className: "CiSandbox",
      retirement,
      busy: this.#running !== null,
      purge: (reason) => this.#clear(reason),
    });
  }

  async #run(jobId: string): Promise<void> {
    const container = this.ctx.container;
    const d1 = this.env.DB;
    const job = await loadJob(d1, jobId);
    if (!job) throw new Error(`No CI job ${jobId}`);
    if (FINISHED.has(job.status)) return;
    if (!container) {
      await report(this.env, jobId, {
        done: {
          status: "failed",
          error: "No sandbox container is configured for this deployment.",
        },
      });
      return;
    }
    const spec = JSON.parse(job.spec) as StoredJob;
    // Claim before preparing checkout. Cancellation may have won since loadJob;
    // in that case no runner may start using a source whose claim was released.
    const kdb = db(d1);
    const claimed = await kdb
      .updateTable("ci_jobs")
      .set({
        status: "running",
        claimed_by: "sandbox",
        started_at: nowIso(),
        execution_identity: spec.image === "default" ? this.verificationIdentity() : null,
      })
      .where("id", "=", jobId)
      .where("status", "in", ["queued", "running"])
      .where(
        "run_id",
        "in",
        kdb.selectFrom("ci_runs").select("id").where("status", "in", ["queued", "running"]),
      )
      .executeTakeFirst();
    if (claimed.numUpdatedRows === 0n) return;
    let done: CiJobReport["done"];
    try {
      // Packages publish to the public URL the registry answers on.
      const origin = String(Reflect.get(this.env, "PUBLIC_URL") || "http://localhost:5180");
      const credential = await mintJobToken(d1, jobId, spec.timeoutMinutes);
      const payload = await jobPayload(d1, job, { origin, token: credential });

      // A retried step starts over and clears the earlier attempt.
      await batch(d1, [
        kdb.deleteFrom("ci_logs").where("job_id", "=", jobId),
        kdb
          .updateTable("ci_steps")
          .set({ status: "pending", exit_code: null, started_at: null, finished_at: null })
          .where("job_id", "=", jobId),
      ]);

      const deadline = Date.now() + spec.timeoutMinutes * 60_000;
      const say = (text: string) => report(this.env, jobId, { logs: [{ step: SETUP_STEP, text }] });
      await say(`Starting a ${spec.instance} sandbox (image ${spec.image})…\n`);
      // A container already running belongs to an earlier attempt (a run in progress
      // in this object would have been joined): after a deploy restarts the object,
      // its processes may still be writing. Replace it rather than build on top.
      if (container.running) {
        await say("Replacing the sandbox an earlier attempt left running…\n");
        await container.destroy();
        for (const until = Date.now() + 60_000; container.running && Date.now() < until;)
          await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const start = () =>
        container.start({
          image: container.images[spec.image] ?? container.images.default!,
          instance: spec.instance,
          enableInternet: true,
          env: BASE_ENV,
        });
      start();
      await this.#ready(container, start);

      await say(`Checking out ${payload.ref} at ${payload.commit.slice(0, 12)}…\n`);
      const source = await ciSource(this.env, job.repo_id, job.source_id, { runId: job.run_id });
      const token = await upstreamToken(this.env, source.artifacts_name, "read");
      const gitEnv = {
        ...BASE_ENV,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
        GIT_TERMINAL_PROMPT: "0",
      };
      const checkout = [
        // A container that outlived an earlier attempt still has its checkout.
        `rm -rf ${WORKDIR}`,
        // Shallow: the credentials end with this command, so steps get the recent history
        // they're given and can't fetch more (gm is versioned by its tree, not history).
        `git clone --quiet --depth 50 --single-branch --branch "$BRANCH" "$REMOTE" ${WORKDIR}`,
        `cd ${WORKDIR}`,
        `git checkout --quiet "$COMMIT" 2>/dev/null || { git fetch --quiet --depth 1 origin "$COMMIT" && git checkout --quiet "$COMMIT"; }`,
        `git remote remove origin`,
        `git log -1 --format='%h %s'`,
      ].join(" && ");
      const code = await this.#exec(container, jobId, SETUP_STEP, checkout, {
        cwd: "/",
        env: {
          ...gitEnv,
          BRANCH: job.source_id === "canonical" ? payload.ref : source.default_branch,
          REMOTE: source.artifacts_remote,
          COMMIT: payload.commit,
        },
        deadline,
      });
      if (code !== 0) {
        done = { status: "failed", exitCode: code, error: "Checkout failed." };
        return;
      }

      // Package tools come preconfigured with the job's credential.
      const files = Object.entries(payload.files);
      if (files.length) {
        const write = files
          .map((_, i) => `mkdir -p "$(dirname "$P${i}")" && printf '%s' "$C${i}" > "$P${i}"`)
          .join(" && ");
        const fileEnv = Object.fromEntries(
          files.flatMap(([path, content], i) => [
            [`P${i}`, `${CONFIG_DIR}/${path}`],
            [`C${i}`, content],
          ]),
        );
        await this.#exec(container, jobId, SETUP_STEP, write, {
          cwd: "/",
          env: { ...BASE_ENV, ...fileEnv },
          deadline,
        });
      }
      done = await this.#steps(
        container,
        jobId,
        { ...payload, env: withConfigDir(payload.env, CONFIG_DIR) },
        deadline,
      );
    } catch (error) {
      if (!(error instanceof Cancelled)) {
        // Left unfinished so the step's retry runs the job again; once retries
        // run out, the workflow marks it failed with this message.
        throw error;
      }
      done = { status: "cancelled" };
    } finally {
      // A terminal report releases source claims. Confirm every process stopped
      // first, including background children and cancelled or failed attempts.
      await container.destroy();
      if (done) await report(this.env, jobId, { done });
      else {
        // Preserve Workflow retries, but clear active-attempt evidence only after
        // confirmed shutdown. This makes a stopped queued retry cancellable while
        // retaining its logs and step history until another attempt starts.
        // Cancellation may have won while destruction was in flight.
        await revokeJobTokens(d1, jobId);
        await d1
          .prepare(`UPDATE ci_jobs SET
          status=CASE WHEN EXISTS (SELECT 1 FROM ci_runs r WHERE r.id=ci_jobs.run_id
            AND r.status IN ('queued','running')) THEN 'queued' ELSE 'cancelled' END,
          finished_at=CASE WHEN EXISTS (SELECT 1 FROM ci_runs r WHERE r.id=ci_jobs.run_id
            AND r.status IN ('queued','running')) THEN NULL ELSE ? END,
          claimed_by=NULL,started_at=NULL,source_completion_pending=0
          WHERE id=? AND status='running'`)
          .bind(nowIso(), jobId)
          .run();
      }
    }
  }

  async #steps(
    container: Container,
    jobId: string,
    job: CiClaimedJob,
    deadline: number,
  ): Promise<NonNullable<CiJobReport["done"]>> {
    for (const step of job.steps) {
      const { cancelled } = await report(this.env, jobId, {
        steps: [{ position: step.position, status: "running" }],
      });
      if (cancelled) throw new Cancelled();
      const code = await this.#exec(container, jobId, step.position, step.run, {
        cwd: WORKDIR,
        env: { ...BASE_ENV, ...job.env },
        deadline,
      });
      const ok = code === 0;
      await report(this.env, jobId, {
        steps: [{ position: step.position, status: ok ? "succeeded" : "failed", exitCode: code }],
      });
      if (!ok) {
        return {
          status: "failed",
          exitCode: code,
          error: code === 124 ? "The job timed out." : `${step.name} exited with ${code}.`,
        };
      }
    }
    return { status: "succeeded", exitCode: 0 };
  }

  /** Wait until the container accepts exec. */
  /**
   * Wait until the container answers. A start can silently not take (right after a
   * deploy, while the previous container is still being torn down), so a container
   * that still isn't running is asked to start again every few seconds.
   */
  async #ready(container: Container, start: () => void) {
    const until = Date.now() + READY_TIMEOUT_MS;
    let restartAt = Date.now() + RESTART_AFTER_MS;
    for (;;) {
      try {
        const probe = await container.exec(["true"]);
        if ((await probe.exitCode) === 0) return;
      } catch (error) {
        if (Date.now() > until) throw new Error(`The sandbox did not start: ${String(error)}`);
        if (!container.running && Date.now() >= restartAt) {
          try {
            start();
          } catch {
            // Already starting; the next probe will tell.
          }
          restartAt = Date.now() + RESTART_AFTER_MS;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  /**
   * Run a bash script, streaming combined output into the job's log. Returns
   * the exit code (124 on timeout). Throws Cancelled if the run was cancelled.
   */
  async #exec(
    container: Container,
    jobId: string,
    step: number,
    script: string,
    options: { cwd: string; env: Record<string, string>; deadline: number },
  ): Promise<number> {
    const process = await container.exec(["/bin/bash", "-eo", "pipefail", "-c", script], {
      cwd: options.cwd,
      env: options.env,
      stdout: "pipe",
      stderr: "combined",
    });
    let buffer = "";
    let cancelled = false;
    let timedOut = false;
    let flushing: Promise<void> = Promise.resolve();
    const flush = () => {
      if (!buffer) return flushing;
      const text = buffer;
      buffer = "";
      flushing = flushing.then(async () => {
        const result = await report(this.env, jobId, { logs: [{ step, text }] });
        if (result.cancelled && !cancelled) {
          cancelled = true;
          process.kill();
        }
      });
      return flushing;
    };
    const timer = setInterval(() => void flush(), FLUSH_MS);
    const timeout = setTimeout(
      () => {
        timedOut = true;
        buffer += `\n[gitmatrix] Timed out; stopping.\n`;
        process.kill();
      },
      Math.max(0, options.deadline - Date.now()),
    );
    try {
      const decoder = new TextDecoder();
      for await (const chunk of process.stdout ?? []) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        if (buffer.length >= FLUSH_BYTES) void flush();
      }
      buffer += decoder.decode();
      const code = await process.exitCode;
      await flush();
      if (cancelled) throw new Cancelled();
      return timedOut ? 124 : code;
    } finally {
      clearInterval(timer);
      clearTimeout(timeout);
    }
  }
}

/** The sandbox for one job. */
export function sandbox(env: Env, jobId: string): DurableObjectStub<CiSandbox> {
  return durableStub(env, "CiSandbox", jobId);
}
