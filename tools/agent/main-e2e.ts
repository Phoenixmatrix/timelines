import { spawn } from "node:child_process";
import {
  closeSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

// The complete non-AI E2E suite on every new main commit. `vp run ready` runs only the
// selected journeys, so this host-side watcher is what catches cross-cutting regressions.
const unitName = "gitmatrix-main-e2e";
const unitDirectory = join(homedir(), ".config", "systemd", "user");
export const stateDirectory = join(homedir(), ".local", "state", "gitmatrix-agent", "main-e2e");
const checkoutDirectory = join(stateDirectory, "checkout");
const statePath = join(stateDirectory, "state.json");
const lockPath = join(stateDirectory, "tick.lock");
// The budgets add up under the unit's TimeoutStartSec, so systemd never kills a tick
// before its own timeout has recorded the result (CORE-406).
export const installTimeoutMs = 20 * 60_000;
export const e2eTimeoutMs = 85 * 60_000;
/** After SIGTERM the run gets this long to destroy its environment before SIGKILL. */
export const e2eGraceMs = 3 * 60_000;
export const unitTimeoutMinutes = 120;
const OPEN_STATUSES = new Set(["backlog", "todo", "in_progress"]);

export interface MainE2EResult {
  sha: string;
  success: boolean;
  failedStages: string[];
  failedScenarios: string[];
  evidence: string | null;
  log: string;
  finishedAt: string;
}

export interface MainE2EState {
  lastTested?: string;
  lastResult?: MainE2EResult;
  /** The run finished but the tracker could not be told yet; retried before the next run. */
  reportPending?: { result: MainE2EResult; previousFailed: boolean };
  /** The checkout could not be brought to origin/main, so the watcher cannot test anything. */
  stuck?: StuckState;
}

export interface StuckState {
  reason: string;
  detail: string;
  since: string;
  /** The P0 issue exists (or was found); false means filing it failed and is retried. */
  reported: boolean;
}

export interface ParsedRun {
  complete: { success: boolean; failedStages: string[]; evidence: string | null } | null;
  failedScenarios: string[];
  limitRefused: boolean;
}

/** Reads the JSON event lines `vp run agent test` prints; other lines are ignored. */
export function parseRunLog(text: string): ParsedRun {
  let complete: ParsedRun["complete"] = null;
  const failedScenarios: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.event === "e2e.complete") {
      complete = {
        success: event.success === true,
        failedStages: Array.isArray(event.failedStages)
          ? event.failedStages.filter((stage): stage is string => typeof stage === "string")
          : [],
        evidence: typeof event.evidence === "string" ? event.evidence : null,
      };
    } else if (
      typeof event.scenario === "string" &&
      event.status === "failed" &&
      !failedScenarios.includes(event.scenario)
    ) {
      failedScenarios.push(event.scenario);
    }
  }
  return {
    complete,
    failedScenarios,
    limitRefused:
      /Installation environment limit reached \(\d+\/\d+\)/.test(text) ||
      /Machine environment limit reached \(\d+\)/.test(text),
  };
}

/** What failed, sorted so the same failure always names itself the same way. */
export function failureNames(
  result: Pick<MainE2EResult, "failedScenarios" | "failedStages">,
): string[] {
  const names = result.failedScenarios.length ? result.failedScenarios : result.failedStages;
  return [...names].sort();
}

export function buildTitle(
  result: Pick<MainE2EResult, "failedScenarios" | "failedStages">,
): string {
  if (result.failedStages.includes("timeout")) return "Main E2E failing: timeout";
  const names = failureNames(result);
  if (!names.length) return "Main E2E failing: run did not complete";
  const noun = result.failedScenarios.length ? "" : "stage ";
  const joined = names.join(", ");
  return `Main E2E failing: ${noun}${joined.length > 110 ? `${names.length} failures starting ${names[0]}` : joined}`;
}

export interface TrackedIssue {
  key: string;
  title: string;
  status: string;
}

export type ReportAction =
  | { kind: "none" }
  | { kind: "create"; title: string }
  | { kind: "comment"; issue: string; body: string }
  | { kind: "recovered"; issues: string[]; body: string };

/** Decides what the tracker needs after a finished run. `existing` is every main-e2e issue. */
export function decideReport(
  result: MainE2EResult,
  previousFailed: boolean,
  existing: TrackedIssue[],
): ReportAction {
  const open = existing.filter((issue) => OPEN_STATUSES.has(issue.status));
  if (result.success) {
    if (!previousFailed || !open.length) return { kind: "none" };
    return {
      kind: "recovered",
      issues: open.map((issue) => issue.key),
      body: `Passing again at ${result.sha}.`,
    };
  }
  const title = buildTitle(result);
  const match = open.find((issue) => issue.title === title);
  if (!match) return { kind: "create", title };
  return { kind: "comment", issue: match.key, body: failureBody(result, "Still failing") };
}

export function failureBody(result: MainE2EResult, heading: string): string {
  const scenarios = result.failedScenarios.length
    ? result.failedScenarios.map((name) => `- ${name}`).join("\n")
    : "- none recorded";
  return [
    `${heading} at ${result.sha}.`,
    "",
    `Failed stages: ${result.failedStages.join(", ") || "none recorded"}`,
    "Failed scenarios:",
    scenarios,
    `Evidence: ${result.evidence ?? "none retained"}`,
    `Run log: ${result.log}`,
    "",
    `Reproduce: check out ${result.sha} and run \`vp run agent test\` (the complete non-AI suite).`,
    "",
    `Reported by the main E2E watcher (finished ${result.finishedAt}).`,
  ].join("\n");
}

/** A tick that cannot start because of the environment cap is retried, never reported. */
export function shouldSkipRetest(head: string, state: MainE2EState): boolean {
  return state.lastTested === head && !state.reportPending;
}

/** Why a finished run is not a result: both environment limits mean retry later (CORE-406). */
export type RunOutcome = { kind: "retry-later" } | { kind: "result"; result: MainE2EResult };

/** The outcome of a run's exit: a timeout is a failure of its own, an environment limit is not. */
export function decideOutcome(input: {
  sha: string;
  code: number | null;
  timedOut: boolean;
  parsed: ParsedRun;
  log: string;
  finishedAt: string;
}): RunOutcome {
  const { parsed } = input;
  if (!input.timedOut && parsed.limitRefused && parsed.complete?.failedStages.includes("provision"))
    return { kind: "retry-later" };
  const failedStages = input.timedOut ? ["timeout"] : (parsed.complete?.failedStages ?? []);
  return {
    kind: "result",
    result: {
      sha: input.sha,
      success: !input.timedOut && input.code === 0 && parsed.complete?.success === true,
      failedStages,
      failedScenarios: parsed.failedScenarios,
      evidence: parsed.complete?.evidence ?? null,
      log: input.log,
      finishedAt: input.finishedAt,
    },
  };
}

/** A checkout is usable only with a clean status and exactly origin/main's files. */
export function checkoutProblem(input: {
  syncFailed: string | null;
  porcelain: string;
  diffCode: number | null;
}): { reason: string; detail: string } | null {
  if (input.syncFailed) return { reason: "gm sync failed", detail: input.syncFailed };
  if (input.porcelain.trim())
    return {
      reason: "checkout has local changes",
      detail: input.porcelain.trim().split("\n").slice(0, 20).join("\n"),
    };
  if (input.diffCode !== 0)
    return { reason: "checkout does not match origin/main", detail: "git diff origin/main failed" };
  return null;
}

export type StuckAction =
  | { kind: "none" }
  | { kind: "enter"; stuck: StuckState }
  | { kind: "retry-report" }
  | { kind: "recover"; since: string };

/** Entering stuck files an issue once; staying stuck only retries a report that failed. */
export function decideStuck(
  current: StuckState | undefined,
  problem: { reason: string; detail: string } | null,
  now: string,
): StuckAction {
  if (!problem) return current ? { kind: "recover", since: current.since } : { kind: "none" };
  if (!current || current.reason !== problem.reason)
    return {
      kind: "enter",
      stuck: { reason: problem.reason, detail: problem.detail, since: now, reported: false },
    };
  return current.reported ? { kind: "none" } : { kind: "retry-report" };
}

export const stuckTitle = (reason: string) => `Main E2E watcher stuck: ${reason}`;

/** File the stuck issue unless an open one already carries this reason. */
export function decideStuckReport(reason: string, existing: TrackedIssue[]): ReportAction {
  const title = stuckTitle(reason);
  return existing.some((issue) => OPEN_STATUSES.has(issue.status) && issue.title === title)
    ? { kind: "none" }
    : { kind: "create", title };
}

/** Open stuck issues to comment on when the watcher recovers. */
export function stuckIssuesToClose(existing: TrackedIssue[]): string[] {
  return existing
    .filter((issue) => OPEN_STATUSES.has(issue.status) && issue.title.startsWith(stuckTitle("")))
    .map((issue) => issue.key);
}

/** The unit files. No tokens in them: cf and gm read the user's credential stores at run time. */
const quote = (value: string) =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;

export function serviceUnit(input: {
  checkout: string;
  node: string;
  entry: string;
  path: string;
}): string {
  // systemd does not unquote WorkingDirectory: it takes the raw absolute path.
  if (!isAbsolute(input.checkout) || /\s/.test(input.checkout))
    throw new Error(
      `The main E2E checkout path must be absolute and contain no whitespace: ${JSON.stringify(input.checkout)}`,
    );
  const workingDirectory = input.checkout.replaceAll("%", "%%");
  return `[Unit]\nDescription=Run the complete non-AI E2E suite on the newest main commit\n[Service]\nType=oneshot\nWorkingDirectory=${workingDirectory}\nExecStart=${quote(input.node)} ${quote(input.entry)} --execution local main-e2e tick\nEnvironment=${quote(`PATH=${input.path}`)}\nTimeoutStartSec=${unitTimeoutMinutes}min\n`;
}

export function timerUnit(): string {
  return `[Unit]\nDescription=Check for a new main commit to run full E2E on\n[Timer]\nOnBootSec=5min\nOnUnitInactiveSec=5min\nPersistent=false\n[Install]\nWantedBy=timers.target\n`;
}

interface RunOutput {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  binary: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<RunOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: { ...(options.env ?? process.env), NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = options.timeout ? setTimeout(() => child.kill("SIGKILL"), options.timeout) : null;
    child.on("error", reject);
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function ok(
  binary: string,
  args: string[],
  options: Parameters<typeof run>[2] = {},
): Promise<string> {
  const result = await run(binary, args, options);
  if (result.code !== 0)
    throw new Error(
      `${binary} ${args.join(" ")} failed (${result.code}): ${result.stderr || result.stdout}`,
    );
  return result.stdout;
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event: `main-e2e.${event}`, ...fields }));
}

function stablePathExcluding(roots: string[]): string {
  return [dirname(process.execPath), ...(process.env.PATH ?? "/usr/bin:/bin").split(":")]
    .filter(
      (entry) =>
        isAbsolute(entry) &&
        !roots.some((root) => entry === root || entry.startsWith(`${root}/`)) &&
        !entry.endsWith("/node_modules/.bin"),
    )
    .join(":");
}

async function readState(): Promise<MainE2EState> {
  try {
    return JSON.parse(await readFile(statePath, "utf8")) as MainE2EState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writeState(state: MainE2EState): Promise<void> {
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, statePath);
}

/** Install outside any worktree: the watcher keeps its own checkout and survives their removal. */
export async function installMainE2E(): Promise<void> {
  if (process.platform !== "linux" || process.env.GITMATRIX_REMOTE_HOSTED === "1")
    throw new Error("The main E2E watcher requires Linux user systemd on the trusted host.");
  await ok("systemctl", ["--user", "show-environment"]);
  const source = await realpath(dirname(fileURLToPath(import.meta.url)));
  const installing = dirname(dirname(source));
  const stablePath = stablePathExcluding([installing, checkoutDirectory]);
  const env = { ...process.env, PATH: stablePath };
  const executables = [process.execPath];
  for (const name of ["cf", "gm", "vp"])
    executables.push((await ok("which", [name], { env })).trim());
  for (const executable of executables) {
    const real = await realpath(executable);
    if (real.startsWith(`${installing}/`) || real.startsWith(`${checkoutDirectory}/`))
      throw new Error(
        "The main E2E watcher requires node, cf, gm and vp installed outside any worktree.",
      );
  }
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await mkdir(join(stateDirectory, "runs"), { recursive: true, mode: 0o700 });
  const exists = await stat(join(checkoutDirectory, "tools", "agent", "entry.ts")).then(
    () => true,
    () => false,
  );
  if (!exists)
    await ok("gm", ["worktree", "add", checkoutDirectory, "--revision", "origin/main"], {
      cwd: installing,
      env,
    });
  // A copied agent.local.yml can carry a timeline binding; the watcher tests main.
  await ok("gm", ["timeline", "use", "main"], { cwd: checkoutDirectory, env });
  await mkdir(unitDirectory, { recursive: true });
  const service = serviceUnit({
    checkout: checkoutDirectory,
    node: process.execPath,
    entry: join(checkoutDirectory, "tools/agent/entry.ts"),
    path: stablePath,
  });
  const timer = timerUnit();
  await writeFile(join(unitDirectory, `${unitName}.service`), service);
  await writeFile(join(unitDirectory, `${unitName}.timer`), timer);
  await ok("systemctl", ["--user", "daemon-reload"]);
  await ok("systemctl", ["--user", "enable", "--now", `${unitName}.timer`]);
  log("scheduled", { timer: `${unitName}.timer`, interval: "5min", checkout: checkoutDirectory });
}

export async function mainE2EStatus(): Promise<string> {
  const units = await run("systemctl", [
    "--user",
    "status",
    `${unitName}.timer`,
    `${unitName}.service`,
    "--no-pager",
  ]);
  const state = await readState();
  return [
    units.stdout || units.stderr,
    `Last result: ${state.lastResult ? JSON.stringify(state.lastResult, null, 2) : "none yet"}`,
    state.reportPending ? "A tracker report is pending and will be retried." : "",
    `State: ${stateDirectory}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function uninstallMainE2E(): Promise<void> {
  await run("systemctl", ["--user", "disable", "--now", `${unitName}.timer`]);
  for (const suffix of ["service", "timer"])
    await rm(join(unitDirectory, `${unitName}.${suffix}`), { force: true });
  await ok("systemctl", ["--user", "daemon-reload"]);
  log("removed", { checkout: checkoutDirectory, state: stateDirectory });
  console.log(
    `Kept the checkout (${checkoutDirectory}) and state (${stateDirectory}); delete them by hand.`,
  );
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const readPid = (path: string) => {
  try {
    return Number(readFileSync(path, "utf8"));
  } catch {
    return Number.NaN;
  }
};

/**
 * Takes the lock with its pid already inside it: the pid goes to a temporary file
 * that is hard-linked into place, so a reader never sees an empty lock (CORE-406).
 * A stale lock is moved aside before it is deleted, and a lock that turns out to be
 * a live one is put back, so two removers cannot both win.
 */
export function acquireLockFile(
  lock: string,
  pid: number,
  alive: (pid: number) => boolean = pidAlive,
): boolean {
  const temporary = `${lock}.${pid}.tmp`;
  writeFileSync(temporary, String(pid), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(temporary, lock);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const holder = readPid(lock);
      if (alive(holder)) return false;
      const grave = `${lock}.stale.${pid}`;
      try {
        renameSync(lock, grave);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const moved = readPid(grave);
      if (moved !== holder && alive(moved)) {
        // Another process replaced the stale lock before this rename: give it back.
        try {
          linkSync(grave, lock);
        } catch {
          // The lock was retaken meanwhile; whoever holds it now owns it.
        }
        unlinkSync(grave);
        return false;
      }
      unlinkSync(grave);
    }
    return false;
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // Already gone.
    }
  }
}

async function acquireLock(): Promise<boolean> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  return acquireLockFile(lockPath, process.pid);
}

async function listMainE2EIssues(cwd: string): Promise<TrackedIssue[]> {
  const output = await ok(
    "gm",
    ["issue", "list", "--tag", "main-e2e", "--timeline", "main", "--limit", "200", "-o", "json"],
    { cwd },
  );
  const parsed = JSON.parse(output) as {
    issues?: { key: string; title: string; status: string }[];
  };
  return (parsed.issues ?? []).map(({ key, title, status }) => ({ key, title, status }));
}

async function report(result: MainE2EResult, previousFailed: boolean, cwd: string): Promise<void> {
  const action = decideReport(result, previousFailed, await listMainE2EIssues(cwd));
  const comment = (issue: string, body: string) =>
    ok("gm", ["issue", "comment", issue, body, "--timeline", "main"], { cwd });
  if (action.kind === "create") {
    const file = join(stateDirectory, "runs", `${result.sha}.issue.md`);
    await writeFile(file, failureBody(result, "The complete non-AI E2E suite failed on main"), {
      mode: 0o600,
    });
    const out = await ok(
      "gm",
      [
        "issue",
        "create",
        action.title,
        "--type",
        "bug",
        "--priority",
        "0",
        "--tag",
        "testing",
        "--tag",
        "main-e2e",
        "--description-file",
        file,
        "--timeline",
        "main",
      ],
      { cwd },
    );
    log("issue.created", { title: action.title, output: out.slice(0, 500) });
  } else if (action.kind === "comment") {
    await comment(action.issue, action.body);
    log("issue.commented", { issue: action.issue });
  } else if (action.kind === "recovered") {
    for (const issue of action.issues) await comment(issue, action.body);
    log("issue.recovered", { issues: action.issues });
  }
}

/** Brings the checkout to origin/main, restoring it if sync fails or it holds anything else. */
async function prepareCheckout(
  cwd: string,
): Promise<{ head: string | null; problem: { reason: string; detail: string } | null }> {
  const inspect = async () => {
    // gm sync fetches and rebases this checkout's empty working-copy change onto the new trunk.
    const sync = await run("gm", ["sync"], { cwd });
    const head = (await run("git", ["rev-parse", "origin/main"], { cwd })).stdout.trim();
    const porcelain = (await run("git", ["status", "--porcelain"], { cwd })).stdout;
    const diff = head ? await run("git", ["diff", "--quiet", head], { cwd }) : { code: 1 };
    return {
      head,
      problem: checkoutProblem({
        syncFailed: sync.code === 0 ? null : (sync.stderr || sync.stdout).slice(0, 2000),
        porcelain,
        diffCode: diff.code,
      }),
    };
  };
  let seen = await inspect();
  if (!seen.problem) return seen;
  log("checkout.restore", { reason: seen.problem.reason });
  // Only this checkout is touched: gm commands run in it, and git clean runs only when
  // git confirms its top level is the watcher's own directory.
  await run("gm", ["timeline", "use", "main"], { cwd });
  await run("gm", ["restore", "--from", "trunk"], { cwd });
  const top = (await run("git", ["rev-parse", "--show-toplevel"], { cwd })).stdout.trim();
  if (top && (await realpath(top)) === (await realpath(cwd)))
    await run("git", ["clean", "-fd"], { cwd });
  seen = await inspect();
  return seen;
}

/** File (once, by title) or comment on the stuck issue, and remember whether that worked. */
async function noteStuck(
  action: StuckAction,
  state: MainE2EState,
  cwd: string,
): Promise<MainE2EState> {
  if (action.kind === "enter" || action.kind === "retry-report") {
    const stuck = action.kind === "enter" ? action.stuck : state.stuck!;
    state = { ...state, stuck };
    await writeState(state);
    try {
      const decision = decideStuckReport(stuck.reason, await listMainE2EIssues(cwd));
      if (decision.kind === "create") {
        const file = join(stateDirectory, "runs", "stuck.issue.md");
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(
          file,
          [
            `The main E2E watcher cannot test main: ${stuck.reason}.`,
            "",
            stuck.detail,
            "",
            `Stuck since ${stuck.since}. Fix the checkout ${checkoutDirectory} (the watcher already tried gm timeline use main, gm restore and git clean there).`,
          ].join("\n"),
          { mode: 0o600 },
        );
        await ok(
          "gm",
          [
            "issue",
            "create",
            decision.title,
            "--type",
            "bug",
            "--priority",
            "0",
            "--tag",
            "testing",
            "--tag",
            "main-e2e",
            "--description-file",
            file,
            "--timeline",
            "main",
          ],
          { cwd },
        );
        log("stuck.issue.created", { title: decision.title });
      }
      state = { ...state, stuck: { ...stuck, reported: true } };
      await writeState(state);
    } catch (error) {
      log("stuck.report-failed", { error: String(error) });
    }
  } else if (action.kind === "recover") {
    try {
      for (const key of stuckIssuesToClose(await listMainE2EIssues(cwd)))
        await ok(
          "gm",
          [
            "issue",
            "comment",
            key,
            `Recovered: the checkout is at origin/main again (stuck since ${action.since}).`,
            "--timeline",
            "main",
          ],
          { cwd },
        );
    } catch (error) {
      log("stuck.recover-comment-failed", { error: String(error) });
    }
    state = { ...state, stuck: undefined };
    await writeState(state);
  }
  return state;
}

/** One watcher pass: cheap when main has not moved, the full suite when it has. */
export async function tick(): Promise<void> {
  if (!(await acquireLock())) {
    log("busy");
    return;
  }
  try {
    const cwd = checkoutDirectory;
    let state = await readState();
    if (state.reportPending) {
      await report(state.reportPending.result, state.reportPending.previousFailed, cwd);
      state = { ...state, reportPending: undefined };
      await writeState(state);
    }
    const prepared = await prepareCheckout(cwd);
    const stuckAction = decideStuck(state.stuck, prepared.problem, new Date().toISOString());
    state = await noteStuck(stuckAction, state, cwd);
    if (prepared.problem || !prepared.head) {
      log("stuck", { ...prepared.problem });
      return;
    }
    const head = prepared.head;
    if (shouldSkipRetest(head, state)) {
      log("unchanged", { sha: head });
      return;
    }
    log("start", { sha: head });
    await ok("vp", ["install"], { cwd, timeout: installTimeoutMs });
    await mkdir(join(stateDirectory, "runs"), { recursive: true, mode: 0o700 });
    const logPath = join(stateDirectory, "runs", `${head}.log`);
    const descriptor = openSync(logPath, "w", 0o600);
    let code: number | null;
    let timedOut = false;
    try {
      code = await new Promise<number | null>((resolve, reject) => {
        // The same full non-AI suite as `vp run agent test`: no ready selection.
        const child = spawn(
          process.execPath,
          [join(cwd, "tools/agent/entry.ts"), "--execution", "local", "test"],
          { cwd, env: process.env, stdio: ["ignore", descriptor, descriptor] },
        );
        let killer: NodeJS.Timeout | null = null;
        // SIGTERM first so the run destroys its environment; SIGKILL only after the grace.
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          killer = setTimeout(() => child.kill("SIGKILL"), e2eGraceMs);
        }, e2eTimeoutMs);
        child.on("error", reject);
        child.on("close", (exit) => {
          clearTimeout(timer);
          if (killer) clearTimeout(killer);
          resolve(exit);
        });
      });
    } finally {
      closeSync(descriptor);
    }
    const outcome = decideOutcome({
      sha: head,
      code,
      timedOut,
      parsed: parseRunLog(await readFile(logPath, "utf8")),
      log: logPath,
      finishedAt: new Date().toISOString(),
    });
    if (outcome.kind === "retry-later") {
      log("environment-limit", { sha: head, log: logPath });
      return;
    }
    const result = outcome.result;
    const previousFailed = state.lastResult ? !state.lastResult.success : false;
    log("finished", { ...result });
    state = {
      lastTested: head,
      lastResult: result,
      ...(!result.success || previousFailed ? { reportPending: { result, previousFailed } } : {}),
    };
    await writeState(state);
    if (state.reportPending) {
      await report(result, previousFailed, cwd);
      await writeState({ lastTested: head, lastResult: result });
    }
  } finally {
    await rm(lockPath, { force: true });
  }
}
