// Running a CI job on Cloudflare Sandbox. One Durable Object per job owns one
// container (ctx.container, image from ci/Dockerfile): start it, clone the
// commit straight from Artifacts with a short-lived read token, run each step
// with bash, stream output into D1, then destroy the container so nothing
// idles on the bill.

import { DurableObject } from "cloudflare:workers";
import type { CiClaimedJob, CiJobReport } from "../../shared/api.ts";
import { upstreamToken } from "../artifacts.ts";
import { batch, db, nowIso } from "../schema.ts";
import {
  JobCredentialsRevoked,
  jobPayload,
  loadJob,
  report,
  settleStoppedJob,
  type StoredJob,
} from "./jobs.ts";
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
import {
  cutoverControl,
  withCutoverAdmission,
  withCutoverAlarmAdmission,
} from "../durable/cutover-admission.ts";
import { reportCutoverRuntime } from "../durable/cutover-runtime.ts";
import { resolveJobAuthority, WorkAuthorizationError } from "./admission.ts";
import { CONTENT_CONTRACT_VERSION } from "../../shared/spaces.ts";

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
// How long log writes may keep failing (D1 "Network connection lost") before the
// job is stopped; a revoked authority stops it at once.
const FLUSH_FAILURE_MS = 30_000;
const READY_TIMEOUT_MS = 180_000;
/** A container that still isn't running after this long is asked to start again. */
const RESTART_AFTER_MS = 10_000;
/** Log lines before step 0 (start-up and checkout) are filed under this step. */
export const SETUP_STEP = -1;

class Cancelled extends Error {}

const FINISHED = new Set(["succeeded", "failed", "cancelled", "skipped"]);

const CUTOVER_EXECUTION = "space-cutover-execution";
interface SandboxAdmission {
  ticket: string;
  epoch: number;
  jobId: string;
  sealed?: boolean;
}

export class CiSandbox extends DurableObject<Env> implements Purgeable {
  #running: Promise<void> | null = null;
  #shutdownConfirmed = false;

  /** Maintenance-only attestation; neither starts a container nor touches job state. */
  cutoverRuntime(runId: string) {
    return reportCutoverRuntime(this.env, runId, "ci-sandbox");
  }

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
    this.#running ??= this.#admittedRun(jobId).finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #admittedRun(jobId: string): Promise<void> {
    const control = cutoverControl(this.env);
    let lease = await this.ctx.storage.get<SandboxAdmission>(CUTOVER_EXECUTION);
    if (lease && lease.jobId !== jobId) throw new Error("Sandbox has an unresolved prior job");
    if (lease?.sealed) throw new Error("Sandbox execution was sealed by cutover");
    if (lease && !this.ctx.container)
      throw new Error("Sandbox container binding unavailable for execution reconciliation");
    if (lease && !this.ctx.container?.running) {
      // A replayed run can race the cleanup of the call it replaces: that call
      // released its ticket while this lease survived (CORE-341: every later
      // run failed with space_cutover_ticket_mismatch). With no container
      // running nothing executes under it, so the stale lease is dropped.
      try {
        await control.assertTicket(lease.ticket, lease.epoch, CONTENT_CONTRACT_VERSION);
      } catch {
        await this.ctx.storage.delete(CUTOVER_EXECUTION);
        lease = undefined;
      }
    }
    if (!lease) {
      // A process predating preparation has no trustworthy execution identity.
      // Do not destroy it or let a new run hide it from the drain inventory.
      if (this.ctx.container?.running)
        throw new Error("Untracked sandbox execution blocks cutover");
      lease = {
        ...(await control.acquire("ci-sandbox", CONTENT_CONTRACT_VERSION, {
          kind: "ci-sandbox",
          instanceId: this.ctx.id.toString(),
        })),
        jobId,
      };
      await this.ctx.storage.put(CUTOVER_EXECUTION, lease);
    }
    await control.assertTicket(lease.ticket, lease.epoch, CONTENT_CONTRACT_VERSION);
    this.#shutdownConfirmed = !this.ctx.container?.running;
    try {
      await this.#run(jobId);
    } finally {
      // Destruction can fail or return before shutdown. Keep the independent
      // lease in that case: a terminated CiRun is not container-stop evidence.
      if (this.#shutdownConfirmed && !this.ctx.container?.running) {
        await control.release(lease.ticket);
        await this.ctx.storage.delete(CUTOVER_EXECUTION);
      }
    }
  }

  /** Read-only provider state; never stops an execution to manufacture a drain. */
  async cutoverDrainStatus() {
    const lease = await this.ctx.storage.get<SandboxAdmission>(CUTOVER_EXECUTION);
    const containerRunning = this.ctx.container?.running ?? null;
    return {
      ticket: lease?.ticket ?? null,
      epoch: lease?.epoch ?? null,
      jobId: lease?.jobId ?? null,
      running: this.#running !== null,
      containerRunning,
      drained: this.#running === null && containerRunning === false,
    };
  }

  /** Seal a stopped orphan before control releases it; status alone races replay. */
  async cutoverReconcile(runId: string, ticket: string, epoch: number): Promise<boolean> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const control = cutoverControl(this.env);
      const run = await control.status();
      if (!run || run.runId !== runId || run.phase !== "fenced")
        throw new Error("Sandbox reconciliation requires the exact fenced cutover");
      const lease = await this.ctx.storage.get<SandboxAdmission>(CUTOVER_EXECUTION);
      if (!lease || lease.ticket !== ticket || lease.epoch !== epoch)
        throw new Error("Sandbox reconciliation ticket mismatch");
      if (this.#running || !this.ctx.container || this.ctx.container.running) return false;
      await this.ctx.storage.put(CUTOVER_EXECUTION, { ...lease, sealed: true });
      return true;
    });
  }

  // The purge contract also preserves unresolved execution tickets: independent
  // control, not a business-store purge, decides when an orphan is drained.
  async purge(reason: string): Promise<PurgeReport> {
    const report = await withCutoverAdmission(this.env, "ci-sandbox", async () => {
      if (this.#running || (await this.ctx.storage.get(CUTOVER_EXECUTION)))
        throw new Error("Cannot purge an unresolved sandbox execution");
      return this.#clear(reason);
    });
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
    return withCutoverAdmission(this.env, "ci-sandbox", () =>
      scheduleRetirement(this.ctx.storage, reason, name, delayMs),
    );
  }

  storageReport() {
    return storageReport(this.ctx.storage);
  }

  override async alarm(): Promise<void> {
    return withCutoverAlarmAdmission(this.env, "ci-sandbox", this.ctx.storage, () =>
      this.#retirementAlarm(),
    );
  }

  async #retirementAlarm(): Promise<void> {
    const retirement = await pendingRetirement(this.ctx.storage);
    if (!retirement) return;
    await settleRetirement({
      storage: this.ctx.storage,
      env: this.env,
      className: "CiSandbox",
      retirement,
      busy: this.#running !== null || !!(await this.ctx.storage.get(CUTOVER_EXECUTION)),
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
    let done: CiJobReport["done"];
    const failures: unknown[] = [];
    try {
      await resolveJobAuthority(this.env, jobId);
      const claimed = await kdb
        .updateTable("ci_jobs")
        .set({
          status: "running",
          claimed_by: "sandbox",
          started_at: nowIso(),
          source_completion_pending: 1,
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
      // Packages publish to the public URL the registry answers on.
      const origin = String(Reflect.get(this.env, "PUBLIC_URL") || "http://localhost:5180");
      const credential = await mintJobToken(this.env, jobId, spec.timeoutMinutes);
      const payload = await jobPayload(this.env, job, { origin, token: credential });

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
      await resolveJobAuthority(this.env, jobId);
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
      } else {
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
      }
    } catch (error) {
      if (error instanceof Cancelled) done = { status: "cancelled" };
      else {
        // Preserve the execution error even if shutdown or final reporting fails.
        // An infrastructure failure remains unfinished for the Workflow retry.
        failures.push(error);
      }
    }
    try {
      // A terminal report releases source claims. Confirm every process stopped
      // first, including background children and cancelled or failed attempts.
      this.#shutdownConfirmed = false;
      await container.destroy();
      if (container.running) throw new Error("Sandbox shutdown has not been confirmed");
      this.#shutdownConfirmed = true;
      if (done) await report(this.env, jobId, { done });
      else {
        try {
          await resolveJobAuthority(this.env, jobId);
        } catch (error) {
          if (error instanceof WorkAuthorizationError)
            await settleStoppedJob(this.env, jobId, "Job authority is no longer current.");
          throw error;
        }
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
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "Sandbox execution and cleanup failed");
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
    await resolveJobAuthority(this.env, jobId);
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
    // The flush waiting behind the one in flight. It takes the buffer when it
    // starts, so every caller meanwhile shares it instead of queueing another.
    let queued: Promise<void> | null = null;
    let failingSince: number | null = null;
    const flush = () => {
      if (queued) return queued;
      // One write at a time, taking the buffer when it starts, so text kept for a
      // retry stays ahead of what arrived since. Even a silent process must
      // observe revocation on the next poll.
      const run = (flushing = flushing.then(async () => {
        queued = null;
        const text = buffer;
        buffer = "";
        let result: { cancelled: boolean };
        try {
          await resolveJobAuthority(this.env, jobId);
          result = await report(this.env, jobId, {
            logs: [{ step, text }],
          });
        } catch (error) {
          // A transient write failure keeps the text for the next flush instead
          // of throwing away a nearly finished job. A write that committed before
          // failing is stored twice. Revoked authority or credentials end the job.
          failingSince ??= Date.now();
          if (
            !(error instanceof WorkAuthorizationError) &&
            !(error instanceof JobCredentialsRevoked) &&
            Date.now() - failingSince < FLUSH_FAILURE_MS
          ) {
            buffer = text + buffer;
            return;
          }
          process.kill();
          throw error;
        }
        failingSince = null;
        if (result.cancelled && !cancelled) {
          cancelled = true;
          process.kill();
        }
      }));
      return (queued = run);
    };
    // Flush until the text is written; flush throws once failures outlast FLUSH_FAILURE_MS.
    const drain = async () => {
      await flush();
      while (buffer) {
        await new Promise((resolve) => setTimeout(resolve, FLUSH_MS));
        await flush();
      }
    };
    const timer = setInterval(() => {
      void flush().catch(() => {});
    }, FLUSH_MS);
    const timeout = setTimeout(
      () => {
        timedOut = true;
        buffer += `\n[gitmatrix] Timed out; stopping.\n`;
        process.kill();
      },
      Math.max(0, options.deadline - Date.now()),
    );
    let outcome: { code: number } | { error: unknown };
    try {
      const decoder = new TextDecoder();
      for await (const chunk of process.stdout ?? []) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        if (buffer.length >= FLUSH_BYTES) void flush().catch(() => {});
      }
      buffer += decoder.decode();
      const code = await process.exitCode;
      await drain();
      if (cancelled) throw new Cancelled();
      outcome = { code: timedOut ? 124 : code };
    } catch (error) {
      outcome = { error };
    } finally {
      clearInterval(timer);
      clearTimeout(timeout);
    }
    // Drain writes after stopping timers. A flush failure takes precedence over
    // the stream result, but cannot bypass timer cleanup or process shutdown.
    try {
      await drain();
    } catch (error) {
      process.kill();
      await process.exitCode;
      throw error;
    }
    if ("error" in outcome) throw outcome.error;
    return outcome.code;
  }
}

/** The sandbox for one job. */
export function sandbox(env: Env, jobId: string): DurableObjectStub<CiSandbox> {
  return durableStub(env, "CiSandbox", jobId);
}
