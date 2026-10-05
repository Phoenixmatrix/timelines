// Managed by `gm agent setup` (Gitmatrix steps, CORE-242): what you tell the
// agent reaches the next Gitmatrix step, marked `hook`. On each submitted
// input it hands gm the text; gm keeps it only in a checkout working in a
// timeline, redacts it, and never prints. Without gm installed it does nothing.
// Oh My Pi raises `input` for interactive and RPC sessions, not for `omp -p`.
import { spawnSync } from "node:child_process";

interface Input {
  text?: string;
}
interface Context {
  cwd?: string;
  sessionManager?: { getSessionId?: () => string };
}
interface Pi {
  on(event: "input", handler: (event: Input, ctx: Context) => unknown): void;
}

export default function gitmatrixSteps(pi: Pi): void {
  pi.on("input", (event, ctx) => {
    const prompt = event.text ?? "";
    if (!prompt.trim()) return;
    try {
      spawnSync("gm", ["hook", "pi"], {
        input: JSON.stringify({
          session_id: ctx.sessionManager?.getSessionId?.() ?? "",
          prompt,
          cwd: ctx.cwd ?? process.cwd(),
        }),
        stdio: ["pipe", "ignore", "ignore"],
        timeout: 5_000,
      });
    } catch {
      // No gm here: nothing to record.
    }
  });
}
