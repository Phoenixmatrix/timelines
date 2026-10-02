// Running a CI job on Cloudflare Sandbox. One Durable Object per job owns one
// container (ctx.container, image from ci/Dockerfile): start it, clone the
// commit straight from Artifacts with a short-lived read token, run each step
// with bash, stream output into D1, then destroy the container so nothing
// idles on the bill.

import { DurableObject } from "cloudflare:workers";
import type { CiClaimedJob } from "../../shared/api.ts";
import { upstreamToken } from "../artifacts.ts";
import { batch, db, nowIso } from "../schema.ts";
import { jobPayload, loadJob, report, type StoredJob } from "./jobs.ts";
import { mintJobToken, withConfigDir } from "./registry.ts";

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
const READY_TIMEOUT_MS = 90_000;
/** Log lines before step 0 (start-up and checkout) are filed under this step. */
export const SETUP_STEP = -1;

class Cancelled extends Error {}

const FINISHED = new Set(["succeeded", "failed", "cancelled", "skipped"]);

export class CiSandbox extends DurableObject<Env> {
  #running: Promise<void> | null = null;

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
    // Packages publish to the public URL the registry answers on.
    const origin = String(Reflect.get(this.env, "PUBLIC_URL") || "http://localhost:5180");
    const credential = await mintJobToken(d1, jobId, spec.timeoutMinutes);
    const payload = await jobPayload(d1, job, { origin, token: credential });

    // A retried step starts over: claim (again) and clear the earlier attempt.
    const kdb = db(d1);
    await batch(d1, [
      kdb
        .updateTable("ci_jobs")
        .set({ status: "running", claimed_by: "sandbox", started_at: nowIso() })
        .where("id", "=", jobId)
        .where("status", "in", ["queued", "running"]),
      kdb.deleteFrom("ci_logs").where("job_id", "=", jobId),
      kdb
        .updateTable("ci_steps")
        .set({ status: "pending", exit_code: null, started_at: null, finished_at: null })
        .where("job_id", "=", jobId),
    ]);

    const deadline = Date.now() + spec.timeoutMinutes * 60_000;
    try {
      const say = (text: string) => report(this.env, jobId, { logs: [{ step: SETUP_STEP, text }] });
      await say(`Starting a ${spec.instance} sandbox (image ${spec.image})…\n`);
      if (!container.running) {
        container.start({
          image: container.images[spec.image] ?? container.images.default!,
          instance: spec.instance,
          enableInternet: true,
          env: BASE_ENV,
        });
      }
      await this.#ready(container);

      await say(`Checking out ${payload.ref} at ${payload.commit.slice(0, 12)}…\n`);
      const token = await upstreamToken(this.env, job.artifacts_name, "read");
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
        `git clone --quiet --depth 50 --single-branch --branch "$BRANCH" "$REMOTE" ${WORKDIR}`,
        `cd ${WORKDIR}`,
        `git checkout --quiet "$COMMIT" 2>/dev/null || { git fetch --quiet --depth 1 origin "$COMMIT" && git checkout --quiet "$COMMIT"; }`,
        `git log -1 --format='%h %s'`,
      ].join(" && ");
      const code = await this.#exec(container, jobId, SETUP_STEP, checkout, {
        cwd: "/",
        env: {
          ...gitEnv,
          BRANCH: payload.ref,
          REMOTE: job.artifacts_remote,
          COMMIT: payload.commit,
        },
        deadline,
      });
      if (code !== 0) {
        await report(this.env, jobId, {
          done: { status: "failed", exitCode: code, error: "Checkout failed." },
        });
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
      await this.#steps(
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
      await report(this.env, jobId, { done: { status: "cancelled" } });
    } finally {
      await container.destroy().catch(() => {});
    }
  }

  async #steps(container: Container, jobId: string, job: CiClaimedJob, deadline: number) {
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
        await report(this.env, jobId, {
          done: {
            status: "failed",
            exitCode: code,
            error: code === 124 ? "The job timed out." : `${step.name} exited with ${code}.`,
          },
        });
        return;
      }
    }
    await report(this.env, jobId, { done: { status: "succeeded", exitCode: 0 } });
  }

  /** Wait until the container accepts exec. */
  async #ready(container: Container) {
    const until = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      try {
        const probe = await container.exec(["true"]);
        if ((await probe.exitCode) === 0) return;
      } catch (error) {
        if (Date.now() > until) throw new Error(`The sandbox did not start: ${String(error)}`);
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
  // The config names the class by string, so its binding type can't infer it.
  return (env.CI_SANDBOX as unknown as DurableObjectNamespace<CiSandbox>).getByName(jobId);
}
