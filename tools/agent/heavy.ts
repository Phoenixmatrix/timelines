// One heavy test run at a time on this host (CORE-306). Several agents share
// a trusted host; when their browser-mode tests and live E2E overlap, the
// kernel kills Chromium renderers and the runs fail on memory, not on code.
// The website's tests and the live E2E each hold this lock while they run;
// anything else (checks, builds, single test files) runs freely.
//
// Dependency-free, so CI's Sandbox containers can load it before an install
// finishes; without `flock` (not a Linux host) the work runs unlocked.

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where agent harness state lives (environment.ts's `registry`). */
export const stateDirectory = join(homedir(), ".local", "state", "gitmatrix-agent");
/** Set for the lock holder's children, so nested heavy work doesn't wait on itself. */
const HELD = "GITMATRIX_HEAVY_LOCK_HELD";
/** A live E2E can take most of an hour on a loaded host; a stuck holder still ends. */
const HEAVY_WAIT_SECONDS = 90 * 60;

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

/** Run heavy test work alone on this host, saying who it waits for. */
export async function heavyLock<T>(label: string, action: () => Promise<T>): Promise<T> {
  if (process.env[HELD]) return action();
  const owner = join(stateDirectory, "heavy.owner.json");
  const run = async () => {
    process.env[HELD] = label;
    // Who holds it is for a waiting run's message only.
    await writeFile(
      owner,
      JSON.stringify({ pid: process.pid, label, cwd: process.cwd(), since: new Date() }),
      { mode: 0o600 },
    ).catch(() => {});
    try {
      return await action();
    } finally {
      delete process.env[HELD];
    }
  };
  // A CI container may have no writable home or no flock: there's no one to share with.
  const unlocked = (why: string) => {
    console.error(JSON.stringify({ event: "heavy.unlocked", label, note: why }));
    return run();
  };
  try {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  } catch {
    return unlocked(`${stateDirectory} can't be created`);
  }
  let started = false;
  try {
    return await withFileLock(
      join(stateDirectory, "heavy.lock"),
      HEAVY_WAIT_SECONDS,
      () => {
        started = true;
        return run();
      },
      async () =>
        console.error(
          JSON.stringify({
            event: "heavy.wait",
            label,
            holder: JSON.parse((await readFile(owner, "utf8").catch(() => "null")) || "null"),
            note: "Another heavy test run holds this host (CORE-306); waiting for it.",
          }),
        ),
    );
  } catch (error) {
    if (started || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return unlocked("flock is unavailable");
  }
}
