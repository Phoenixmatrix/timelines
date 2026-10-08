// Host helpers for heavy test runs (CORE-306): how much memory is available,
// to say so when Chromium dies under pressure, and an exclusive kernel file
// lock (the environment registry's). Heavy runs themselves no longer queue
// behind each other: agents run them in parallel (CORE-108).
//
// Dependency-free, so CI's Sandbox containers can load it before an install
// finishes.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

/** Bytes the kernel says can be allocated without swapping (MemAvailable), if known. */
export function parseMemAvailable(meminfo: string): number | null {
  const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo);
  return match ? Number(match[1]) * 1024 : null;
}

export async function availableMemory(): Promise<number | null> {
  const meminfo = await readFile("/proc/meminfo", "utf8").catch(() => null);
  return meminfo === null ? null : parseMemAvailable(meminfo);
}

export function gib(bytes: number | null): string {
  return bytes === null ? "unknown" : `${(bytes / 2 ** 30).toFixed(1)} GiB`;
}

/**
 * Hold an exclusive kernel lock on `path` (released on crashes too) while
 * `action` runs. `busy` is called once if another process holds it.
 */
export async function withFileLock<T>(
  path: string,
  waitSeconds: number,
  action: () => Promise<T>,
  busy?: () => void | Promise<void>,
): Promise<T> {
  // The helper holds the lock until its stdin closes.
  const hold = (wait: string[]) =>
    spawn(
      "flock",
      [
        "--exclusive",
        ...wait,
        path,
        process.execPath,
        "-e",
        'process.stdout.write("locked\\n"); process.stdin.resume(); process.stdin.on("end", () => process.exit(0));',
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
  const acquire = async (wait: string[]) => {
    const child = hold(wait);
    let diagnostic = "";
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostic += chunk.toString();
    });
    const closed = Promise.withResolvers<void>();
    child.once("close", () => closed.resolve());
    const ready = Promise.withResolvers<boolean>();
    child.once("error", ready.reject);
    child.once("exit", (code) =>
      code === 1 && wait[0] === "--nonblock"
        ? ready.resolve(false)
        : ready.reject(new Error(`Lock ${path} failed (${code}): ${diagnostic}`)),
    );
    child.stdout.once("data", () => ready.resolve(true));
    const locked = await ready.promise;
    return { locked, child, closed };
  };
  let held = await acquire(["--nonblock"]);
  if (!held.locked) {
    await busy?.();
    held = await acquire(["--wait", String(waitSeconds)]);
  }
  try {
    return await action();
  } finally {
    held.child.stdin.end();
    await held.closed.promise;
  }
}
