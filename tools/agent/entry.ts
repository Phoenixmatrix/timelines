import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { currentRemote, selectExecution } from "./remote-environment.ts";

// Only Node builtins are loaded before selection: remote use never imports Playwright.
const root = await realpath(fileURLToPath(new URL("../..", import.meta.url)));
const args = process.argv.slice(2);
let execution: string | undefined;
try {
  for (let i = 0; i < args.length && args[i] !== "--"; i++) {
    if (args[i] === "--execution" || args[i]?.startsWith("--execution=")) {
      if (execution !== undefined) throw new Error("Specify --execution only once.");
      const inline = args[i]!.split("=")[1];
      execution = inline ?? args[i + 1];
      if (!execution) throw new Error("--execution requires local or cloudflare.");
      args.splice(i, inline === undefined ? 2 : 1);
      i--;
    }
  }
  const config = await readFile(join(root, ".gitmatrix/development.json"), "utf8")
    .then((text) => JSON.parse(text) as { execution?: unknown })
    .catch((error: NodeJS.ErrnoException): { execution?: unknown } => {
      if (error.code === "ENOENT") return {};
      throw error;
    });
  const remote = await currentRemote(root);
  const local = await readFile(join(root, ".gitmatrix-agent/environment.json"), "utf8")
    .then((text) => JSON.parse(text) as { status?: string })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
  const hasLocal = local && local.status !== "deleted" && local.status !== "orphaned";
  if (remote && hasLocal)
    throw new Error(
      "Both local and cloud environments exist; resolve the conflicting ownership journals before continuing.",
    );
  const mode = selectExecution(
    execution,
    process.env.GITMATRIX_AGENT_EXECUTION,
    config.execution,
    remote ? "cloudflare" : hasLocal ? "local" : undefined,
  );
  process.argv = [...process.argv.slice(0, 2), ...args];
  if (mode === "cloudflare") {
    const { remoteMain } = await import("./remote.ts");
    await remoteMain(root, args);
  } else if (args[0] === "main-e2e" && args[1] === "tick" && args.length === 2) {
    // The watcher's tick installs dependencies before anything needs them: it
    // must not load main.ts (Playwright and friends) first (CORE-406).
    const { tick } = await import("./main-e2e.ts");
    await tick();
  } else {
    await import("./main.ts");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Agent execution failed.");
  process.exitCode = 1;
}
