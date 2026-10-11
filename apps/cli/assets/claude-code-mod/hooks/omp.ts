// Installed by gm agent setup --harness pi into .omp/extensions/gitmatrix-agent/.
// Native OMP ExtensionAPI; does not replace the user's status line or settings.
import { execFile } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { identityLine, resolveIdentity } from "./identity";

export default function gitmatrixAgent(pi: ExtensionAPI): void {
  let generation = 0;
  let stopTimer: (() => void) | undefined;
  async function refresh(ctx: ExtensionContext): Promise<void> {
    const request = ++generation;
    const cwd = ctx.cwd;
    const identity = await resolveIdentity((argv, cwd) => {
      const { promise, resolve } = Promise.withResolvers<{ exitCode: number; stdout: string }>();
      execFile(
        argv[0]!,
        argv.slice(1),
        { cwd, timeout: 10_000, maxBuffer: 256 * 1024 },
        (error, stdout) => resolve({ exitCode: error ? 1 : 0, stdout }),
      );
      return promise;
    }, cwd);
    if (request !== generation || cwd !== ctx.cwd) return;
    ctx.ui.setStatus("gitmatrix-agent", identity ? identityLine(identity) : undefined);
  }

  async function start(ctx: ExtensionContext): Promise<void> {
    ++generation;
    stopTimer?.();
    ctx.ui.setStatus("gitmatrix-agent", undefined);
    const timer = ctx.setInterval(() => refresh(ctx), 60_000);
    stopTimer = () => ctx.clearTimer(timer);
    await refresh(ctx);
  }

  pi.on("session_start", async (_event, ctx) => start(ctx));
  pi.on("session_switch", async (_event, ctx) => start(ctx));
  pi.on("turn_end", async (_event, ctx) => refresh(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    ++generation;
    stopTimer?.();
    stopTimer = undefined;
    ctx.ui.setStatus("gitmatrix-agent", undefined);
  });
  pi.registerCommand("gm-agent", {
    description: "Refresh this checkout's Timelines agent identity",
    handler: async (_args, ctx) => refresh(ctx),
  });
}
