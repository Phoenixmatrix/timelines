// CI runners on demand while developing. Deployed, each CI job gets a
// Cloudflare Sandbox container that exists only for that job. Locally, the
// Worker queues jobs for `gm runner` instead, and this plugin plays the
// Sandbox's part: when the CI Workflow queues a job it calls
// POST /__gitmatrix/ci/dispatch (CI_DISPATCH_URL), and the dev server starts
// `gm runner --once` processes that take queued jobs one at a time and exit
// when there are none left. Nothing has to be left running.

import { spawn } from "node:child_process";
import { hostname } from "node:os";
import type { Plugin, ViteDevServer } from "vite";

export const DISPATCH_PATH = "/__gitmatrix/ci/dispatch";

/** Jobs that may run at once (GITMATRIX_CI_RUNNERS, default 4). */
const SLOTS = Math.max(1, Number(process.env.GITMATRIX_CI_RUNNERS) || 4);
const GM = process.env.GITMATRIX_GM || "gm";

interface RunnerResult {
  jobs: { repo: string; run: number; job: string; status: string }[];
}

export function ciRunners(): Plugin {
  let server: ViteDevServer | null = null;
  let active = 0;
  /** A dispatch arrived while every slot was busy: drain again when one frees up. */
  let owed = 0;
  let missingGm = false;

  const log = (message: string) =>
    server?.config.logger.info(`[ci] ${message}`, { timestamp: true });
  const warn = (message: string) =>
    server?.config.logger.warn(`[ci] ${message}`, { timestamp: true });

  const origin = () => {
    const address = server?.httpServer?.address();
    const port = address && typeof address === "object" ? address.port : 5180;
    return `http://localhost:${port}`;
  };

  /** One short-lived runner: takes at most one job, reports what it ran. */
  const runOnce = () =>
    new Promise<RunnerResult | null>((resolve) => {
      const child = spawn(
        GM,
        ["runner", "--once", "--name", `${hostname()} (vp dev)`, "-o", "json"],
        {
          env: { ...process.env, GM_SERVER: origin() },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
      child.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" && !missingGm) {
          missingGm = true;
          warn(
            `can't start runners: "${GM}" isn't on PATH. Install it with \`pnpm --filter cli run install-bin\`.`,
          );
        }
        resolve(null);
      });
      child.on("close", (code) => {
        const last = stdout.trim().split("\n").pop() ?? "";
        try {
          resolve(JSON.parse(last) as RunnerResult);
        } catch {
          const reason = stderr.trim().split("\n").pop() || `exit ${code}`;
          warn(`runner failed: ${reason}`);
          resolve(null);
        }
      });
    });

  /** Fill a slot: keep taking jobs until none are queued. */
  const drainSlot = async () => {
    active++;
    try {
      for (;;) {
        const result = await runOnce();
        if (!result || result.jobs.length === 0) {
          if (owed > 0) {
            owed--;
            continue;
          }
          return;
        }
        for (const job of result.jobs) log(`${job.repo} #${job.run} ${job.job}: ${job.status}`);
      }
    } finally {
      active--;
    }
  };

  const dispatch = () => {
    if (missingGm) return;
    if (active < SLOTS) void drainSlot();
    else owed++;
  };

  return {
    name: "gitmatrix:ci-runners",
    apply: "serve",
    configureServer(dev) {
      server = dev;
      // Registered before the Cloudflare plugin's middleware, so the Worker
      // never sees this path.
      dev.middlewares.use(DISPATCH_PATH, (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        dispatch();
        res.statusCode = 202;
        res.end();
      });
      // Jobs queued while the dev server was down.
      dev.httpServer?.once("listening", () => setTimeout(dispatch, 3000));
    },
  };
}
