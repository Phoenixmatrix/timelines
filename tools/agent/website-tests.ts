// The website's tests, as `vp run test` (and so `vp run ready` and CI) runs
// them (CORE-306). Browser-mode tests share one headless Chromium; on a host
// short of memory the kernel can kill a renderer, and Vitest then reports
// "Browser connection was closed" and abandons every file it hadn't finished.
// So after such a crash, and only then, the run tries the abandoned browser
// files once more, one at a time. A failed assertion anywhere still fails, and
// is never retried.

import { spawn } from "node:child_process";
import { glob, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { availableMemory, gib } from "./heavy.ts";

/** What Vitest prints when the browser (or a renderer) under its tests dies. */
export const CRASH =
  /Browser connection was closed|VITEST_BROWSER_CONNECTION_CLOSED|page crashed while running tests|Target crashed|Page crashed/i;

/** What the browser project may take while the unit project runs beside it. */
const BROWSER_MEMORY_RESERVE = 3 * 2 ** 30;

/** A test's statuses in Vitest's JSON report once it ran (`pending`: it didn't). */
const OUTCOMES = new Set(["passed", "failed", "skipped", "todo"]);

/** The parts of Vitest's JSON report this reads. */
export interface JsonReport {
  testResults?: {
    name: string;
    status: string;
    assertionResults?: { status: string; failureMessages?: string[] }[];
  }[];
}

/**
 * The browser files to run again after a run that failed: those it didn't
 * finish, when the browser crashed and no assertion failed for a reason of
 * its own. Null when the failure isn't a crash, or isn't only one.
 */
export function abandoned(
  report: JsonReport | null,
  output: string,
  browserFiles: string[],
): string[] | null {
  if (!CRASH.test(output)) return null;
  // Every error outside a test must be the crash itself.
  const unhandled = output.split(/⎯+ Unhandled Error ⎯+/).slice(1);
  if (unhandled.some((block) => !CRASH.test(block))) return null;
  if (!report?.testResults) return browserFiles;
  const failedOnItsOwn = report.testResults.some((file) =>
    (file.assertionResults ?? []).some(
      (test) =>
        test.status === "failed" &&
        (!test.failureMessages?.length ||
          !test.failureMessages.every((message) => CRASH.test(message))),
    ),
  );
  if (failedOnItsOwn) return null;
  // Vitest reports a file it never ran as passed with no tests, and tests it
  // never reached as pending: finished means every test has an outcome.
  const finished = new Set(
    report.testResults
      .filter(
        (file) =>
          file.status !== "failed" &&
          (file.assertionResults ?? []).length > 0 &&
          (file.assertionResults ?? []).every((test) => OUTCOMES.has(test.status)),
      )
      .map((file) => resolve(file.name)),
  );
  return browserFiles.filter((file) => !finished.has(resolve(file)));
}

/** Null means arbitrary Vitest filters: preserve them, but never guess a retry inventory. */
export function selectedBrowserFiles(
  filters: readonly string[],
  inventory: string[],
): string[] | null {
  if (
    !filters.length ||
    (filters.length === 2 && filters[0] === "--project" && filters[1] === "browser") ||
    (filters.length === 1 && filters[0] === "--project=browser")
  )
    return inventory;
  return null;
}

async function vp(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number; output: string }> {
  const child = spawn("vp", args, { env, stdio: ["inherit", "pipe", "pipe"] });
  let output = "";
  const tee = (to: NodeJS.WriteStream) => (chunk: Buffer) => {
    to.write(chunk);
    output += chunk.toString();
  };
  child.stdout.on("data", tee(process.stdout));
  child.stderr.on("data", tee(process.stderr));
  const code = await new Promise<number>((done, fail) => {
    child.once("error", fail);
    child.once("close", (exit, signal) => done(exit ?? (signal ? 1 : 0)));
  });
  return { code, output };
}

const log = (event: Record<string, unknown>) => console.error(JSON.stringify(event));

/** A JSON-reporting run of `filters`, its report read back (null when unreadable). */
async function run(filters: string[], reportPath: string, env?: NodeJS.ProcessEnv) {
  const result = await vp(
    [
      "test",
      "run",
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${reportPath}`,
      ...filters,
    ],
    env,
  );
  const report =
    result.code === 0
      ? null
      : await readFile(reportPath, "utf8")
          .then((text) => JSON.parse(text) as JsonReport)
          .catch(() => null);
  return { ...result, report };
}

/** After a crash that abandoned browser files, run those once more, one at a time. */
async function retryAbandoned(
  first: { code: number; output: string; report: JsonReport | null },
  browserFiles: string[],
): Promise<number> {
  const rerun = abandoned(first.report, first.output, browserFiles);
  if (!rerun?.length) return first.code;
  log({
    event: "website-tests.crashed",
    available: gib(await availableMemory()),
    rerun: rerun.length,
    note: "Chromium died under memory pressure (CORE-306); running the browser files it abandoned once more, one at a time.",
  });
  const second = await vp(["test", "run", "--project", "browser", "--maxWorkers=1", ...rerun]);
  if (second.code !== 0 && CRASH.test(second.output))
    log({
      event: "website-tests.crashed-again",
      available: gib(await availableMemory()),
      note: "The host is still short of memory; free some before running the tests again.",
    });
  return second.code;
}

async function main(): Promise<number> {
  const filters = process.argv.slice(2);
  const scratch = await mkdtemp(join(tmpdir(), "gitmatrix-website-tests-"));
  try {
    const inventory: string[] = [];
    for await (const file of glob("src/**/*.browser.test.tsx")) inventory.push(resolve(file));
    log({ event: "website-tests.start", available: gib(await availableMemory()) });
    if (!filters.length) {
      // The whole suite as two processes at once (CORE-406): Vitest runs projects
      // with different worker caps one after the other, so unit (sized by CPU and
      // memory) and browser (memory-gated, CORE-306) each get their own run.
      // Both size their workers from the same free memory, so the unit process
      // leaves the browser's share out of its own.
      const unitEnv = {
        ...process.env,
        GITMATRIX_TEST_MEMORY_RESERVE_BYTES: String(BROWSER_MEMORY_RESERVE),
      };
      const [unit, browser] = await Promise.all([
        run(["--project", "unit"], join(scratch, "unit.json"), unitEnv),
        run(["--project", "browser"], join(scratch, "browser.json")),
      ]);
      const browserCode = browser.code === 0 ? 0 : await retryAbandoned(browser, inventory);
      return unit.code || browserCode;
    }
    const browserFiles = selectedBrowserFiles(filters, inventory);
    const first = await run(filters, join(scratch, "report.json"));
    // Unknown filters still run unchanged and return their real failure.
    if (first.code === 0 || browserFiles === null) return first.code;
    return await retryAbandoned(first, browserFiles);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exitCode = await main();
