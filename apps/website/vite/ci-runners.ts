// Local CI executes trusted development jobs, not a security sandbox.
import { spawn, type ChildProcess } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import type { Plugin, ViteDevServer } from "vite";
import { z } from "zod";
import { developmentEnvironment } from "./environment.ts";

export const DISPATCH_PATH = "/__gitmatrix/ci/dispatch";

const runnerResult = z.object({
  jobs: z.array(
    z.object({ repo: z.string(), run: z.number(), job: z.string(), status: z.string() }),
  ),
});
type RunnerResult = z.infer<typeof runnerResult>;

export function ciRunners(): Plugin {
  const local = developmentEnvironment(process.env);
  const slots = Number(process.env.GITMATRIX_CI_RUNNERS ?? (local.agent ? 2 : 1));
  if (!Number.isInteger(slots) || slots < 1)
    throw new Error("GITMATRIX_CI_RUNNERS must be a positive integer");
  const gm = process.env.GITMATRIX_GM || "gm";
  const secret = process.env.GITMATRIX_CI_DISPATCH_SECRET;
  let server: ViteDevServer | null = null;
  let active = 0;
  let owed = 0;
  let missingGm = false;
  let stopped = false;
  let startup: NodeJS.Timeout | undefined;
  let closing: Promise<void> | undefined;
  const children = new Set<ChildProcess>();
  // Vite needs Cloudflare credentials for remote bindings; job children must not
  // inherit those credentials, SSH agents, or arbitrary application secrets.
  const runnerEnv: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "CARGO_HOME",
    "RUSTUP_HOME",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "GM_TOKEN",
    "GITMATRIX_TOKEN",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM",
  ]) {
    if (process.env[key] !== undefined) runnerEnv[key] = process.env[key];
  }
  Object.assign(runnerEnv, local.runnerHomes);
  runnerEnv.HOME = local.agent ? runnerEnv.XDG_DATA_HOME : process.env.HOME;
  runnerEnv.GM_SERVER = local.hosted ? `http://127.0.0.1:${local.port}` : local.publicUrl;
  const log = (message: string) =>
    server?.config.logger.info(`[ci] ${message}`, { timestamp: true });
  const warn = (message: string) =>
    server?.config.logger.warn(`[ci] ${message}`, { timestamp: true });

  const signalGroup = (child: ChildProcess, signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
    }
  };
  const shutdown = () => {
    if (closing) return closing;
    stopped = true;
    owed = 0;
    clearTimeout(startup);
    process.off("SIGTERM", terminate);
    process.off("SIGINT", interrupt);
    closing = Promise.all(
      [...children].map(
        (child) =>
          new Promise<void>((resolve) => {
            const timer = setTimeout(() => signalGroup(child, "SIGKILL"), 5000);
            child.once("close", () => {
              clearTimeout(timer);
              resolve();
            });
            signalGroup(child, "SIGTERM");
          }),
      ),
    ).then(() => {});
    return closing;
  };
  const terminate = () => {
    void shutdown().finally(() => process.exit(143));
  };
  const interrupt = () => {
    void shutdown().finally(() => process.exit(130));
  };

  const runOnce = () =>
    new Promise<RunnerResult | null>((resolve) => {
      if (stopped) return resolve(null);
      const child = spawn(
        gm,
        [
          "runner",
          "--once",
          "--name",
          `${hostname()} (vp dev)`,
          "-o",
          "json",
          ...(local.agent ? ["--workdir", `${runnerEnv.TMPDIR}/runner`] : []),
        ],
        {
          env: runnerEnv,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      children.add(child);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk;
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" && !missingGm) {
          missingGm = true;
          warn(`can't start runners: "${gm}" does not exist; build the configured gm binary.`);
        }
        resolve(null);
      });
      child.on("close", (code) => {
        children.delete(child);
        // Checkout helpers share this group; steps are stopped by gm's signal handler.
        signalGroup(child, "SIGKILL");
        if (stopped) return resolve(null);
        try {
          if (code !== 0) throw new Error(`exit ${code}`);
          const result = runnerResult.parse(JSON.parse(stdout.trim().split("\n").pop() ?? ""));
          resolve(result);
        } catch {
          warn(`runner failed: ${stderr.trim().split("\n").pop() || `exit ${code}`}`);
          resolve(null);
        }
      });
    });
  const drainSlot = async () => {
    active++;
    try {
      while (!stopped) {
        const result = await runOnce();
        if (!result) return;
        if (result.jobs.length === 0) {
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
    if (stopped || missingGm) return;
    if (active < slots) void drainSlot();
    else owed++;
  };
  return {
    name: "gitmatrix:ci-runners",
    apply: "serve",
    configureServer(dev) {
      process.once("SIGTERM", terminate);
      process.once("SIGINT", interrupt);
      server = dev;
      dev.middlewares.use(DISPATCH_PATH, (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        const actual = Buffer.from(req.headers.authorization ?? "");
        const expected = Buffer.from(`Bearer ${secret}`);
        if (secret && (actual.length !== expected.length || !timingSafeEqual(actual, expected))) {
          res.statusCode = 401;
          res.end();
          return;
        }
        if (stopped) {
          res.statusCode = 503;
          res.end();
          return;
        }
        dispatch();
        res.statusCode = 202;
        res.end();
      });
      dev.httpServer?.once("listening", () => {
        if (!stopped) startup = setTimeout(dispatch, 3000);
      });
      dev.httpServer?.once("close", () => {
        void shutdown();
      });
      // Run before Vite closes the Worker, so runner termination is not deferred
      // until a potentially long-lived HTTP connection has drained.
      const close = dev.close.bind(dev);
      dev.close = async () => {
        await shutdown();
        await close();
      };
    },
    closeBundle: shutdown,
  };
}
