// Playwright browser cache maintenance: setup installs only Chromium's headless
// shell, and `prune-browsers` removes revisions no Gitmatrix worktree needs.
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  utimes,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

export interface BrowserDescriptor {
  name: string;
  revision: string;
  revisionOverrides?: Record<string, string>;
}

/** Playwright's names for every downloadable browser directory, current and historical. */
const BROWSER_NAMES = [
  "android",
  "chromium",
  "firefox",
  "webkit",
  "ffmpeg",
  "firefox-beta",
  "chromium-tip-of-tree",
  "chromium-headless-shell",
  "chromium-tip-of-tree-headless-shell",
  "winldd",
];
/** A revision renamed aside by an interrupted prune; still ours to finish deleting. */
const TRASH = ".gitmatrix-prune-";

/** Mirrors Playwright's registry: PLAYWRIGHT_BROWSERS_PATH, else the XDG cache default. */
export function browsersRegistry(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env.PLAYWRIGHT_BROWSERS_PATH;
  // "0" keeps browsers inside each playwright-core package; there is no shared cache.
  if (configured === "0") return undefined;
  if (configured) return resolve(configured);
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "ms-playwright");
}

/** Directory names this Playwright version may use, from its browsers.json (any platform). */
export function browserDirectories(descriptors: BrowserDescriptor[]): string[] {
  const names = new Set<string>();
  for (const { name, revision, revisionOverrides } of descriptors) {
    names.add(`${name.replaceAll("-", "_")}-${revision}`);
    for (const [platform, override] of Object.entries(revisionOverrides ?? {}))
      names.add(`${`${name}_${platform}_special`.replaceAll("-", "_")}-${override}`);
  }
  return [...names];
}

/** Same test as Playwright's own garbage collector; anything else in the cache is never touched. */
export function isBrowserDirectory(name: string): boolean {
  return BROWSER_NAMES.some((browser) => name.startsWith(`${browser.replaceAll("-", "_")}-`));
}

/** Every playwright-core version a pnpm lockfile (v9 format) links. */
export function lockfileVersions(lockfile: string): string[] {
  const versions = new Set<string>();
  for (const match of lockfile.matchAll(/^ {2}'?playwright-core@(\d[^:'(\s]*)/gm))
    versions.add(match[1]!);
  return [...versions];
}

/** Revision directory names under `registry` that any of these process paths sit in. */
export function directoriesInUse(registry: string, paths: Iterable<string>): Set<string> {
  const used = new Set<string>();
  const prefix = `${registry.replace(/\/+$/, "")}/`;
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const name = path.slice(prefix.length).split("/")[0];
    if (name) used.add(name);
  }
  return used;
}

export interface PrunePlan {
  keep: { name: string; reasons: string[] }[];
  remove: { name: string; registeredBy: string[] }[];
  /** Kept only because other live installs registered them; `includeOtherInstalls` removes these. */
  heldByOtherInstalls: { name: string; registeredBy: string[] }[];
}

/**
 * Keep what a referenced version needs, anything a process holds open and,
 * unless `includeOtherInstalls`, what other live Playwright installs registered.
 * Only Playwright revision directories (and our own interrupted renames) are candidates.
 */
export function planPrune(input: {
  entries: string[];
  needed: Map<string, string[]>;
  inUse: Map<string, number[]>;
  otherInstalls: Map<string, string[]>;
  includeOtherInstalls: boolean;
}): PrunePlan {
  const plan: PrunePlan = { keep: [], remove: [], heldByOtherInstalls: [] };
  for (const name of [...input.entries].sort()) {
    const trash = name.startsWith(TRASH);
    if (!trash && !isBrowserDirectory(name)) continue;
    const reasons: string[] = [];
    // An interrupted prune's leftover is already gone from Playwright's view.
    if (!trash)
      for (const version of input.needed.get(name) ?? []) reasons.push(`needed by ${version}`);
    if (input.inUse.has(name)) reasons.push(`in use by pid ${input.inUse.get(name)!.join(", ")}`);
    const registeredBy = trash ? [] : (input.otherInstalls.get(name) ?? []);
    if (!reasons.length && registeredBy.length && !input.includeOtherInstalls)
      plan.heldByOtherInstalls.push({ name, registeredBy });
    if (!input.includeOtherInstalls)
      for (const install of registeredBy) reasons.push(`registered by ${install}`);
    if (reasons.length) plan.keep.push({ name, reasons });
    else plan.remove.push({ name, registeredBy });
  }
  return plan;
}

const exec = promisify(execFile);

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

async function readText(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").catch(() => undefined);
}

/** Every worktree of the repository containing `root`, including `root`. */
export async function repositoryWorktrees(root: string): Promise<string[]> {
  const { stdout } = await exec("git", ["-C", root, "worktree", "list", "--porcelain"]);
  const paths = stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
  const present: string[] = [];
  for (const path of paths) if (await exists(path)) present.push(path);
  return present;
}

/** Installed playwright-core packages a worktree can reach, plus every version its lockfiles link. */
async function worktreePlaywright(
  worktree: string,
): Promise<{ versions: string[]; packages: string[] }> {
  const versions = new Set<string>();
  for (const lockfile of ["pnpm-lock.yaml", "node_modules/.pnpm/lock.yaml"])
    for (const version of lockfileVersions((await readText(join(worktree, lockfile))) ?? ""))
      versions.add(version);
  const modules = join(worktree, "node_modules");
  const packages = [join(modules, ".pnpm", "node_modules", "playwright-core")];
  for (const entry of await readdir(join(modules, ".pnpm")).catch(() => []))
    if (entry.startsWith("playwright-core@"))
      packages.push(join(modules, ".pnpm", entry, "node_modules", "playwright-core"));
  // pnpm's global virtual store: <virtualStoreDir>/@/playwright-core/<version>/<hash>.
  const store = (await readText(join(modules, ".modules.yaml")))?.match(
    /^"?virtualStoreDir"?:\s*"?([^"\n]+?)"?\s*,?$/m,
  )?.[1];
  if (store) {
    const base = join(isAbsolute(store) ? store : resolve(modules, store), "@", "playwright-core");
    for (const version of await readdir(base).catch(() => []))
      for (const hash of await readdir(join(base, version)).catch(() => []))
        packages.push(join(base, version, hash, "node_modules", "playwright-core"));
  }
  return { versions: [...versions], packages };
}

interface PlaywrightPackage {
  path: string;
  version: string;
  directories: string[];
}

async function readPackage(path: string): Promise<PlaywrightPackage | undefined> {
  try {
    const { version } = JSON.parse(await readFile(join(path, "package.json"), "utf8")) as {
      version: string;
    };
    const { browsers } = JSON.parse(await readFile(join(path, "browsers.json"), "utf8")) as {
      browsers: BrowserDescriptor[];
    };
    return { path: await realpath(path), version, directories: browserDirectories(browsers) };
  } catch {
    return undefined;
  }
}

/** Every pid's executable, working directory and mapped files (Linux /proc). */
async function processPaths(): Promise<Map<number, string[]>> {
  const result = new Map<number, string[]>();
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const paths: string[] = [];
    for (const link of ["exe", "cwd"]) {
      const target = await readlink(join("/proc", entry, link)).catch(() => undefined);
      if (target) paths.push(target.replace(/ \(deleted\)$/, ""));
    }
    const maps = await readText(join("/proc", entry, "maps"));
    for (const line of maps?.split("\n") ?? []) {
      const path = line.split(/\s+/).slice(5).join(" ");
      if (path.startsWith("/")) paths.push(path.replace(/ \(deleted\)$/, ""));
    }
    if (paths.length) result.set(Number(entry), paths);
  }
  return result;
}

async function directorySize(path: string): Promise<number> {
  const stat = await lstat(path).catch(() => undefined);
  if (!stat) return 0;
  let total = stat.blocks * 512;
  if (stat.isDirectory())
    for (const entry of await readdir(path)) total += await directorySize(join(path, entry));
  return total;
}

function inUseBy(registry: string, processes: Map<number, string[]>): Map<string, number[]> {
  const used = new Map<string, number[]>();
  for (const [pid, paths] of processes)
    for (const name of directoriesInUse(registry, paths))
      used.set(name, [...(used.get(name) ?? []), pid]);
  return used;
}

/**
 * Hold Playwright's own install lock (`__dirlock`, a proper-lockfile mkdir lock)
 * so no `playwright install` runs or garbage-collects while we prune. Refuse
 * rather than steal an existing lock; keep ours fresh so installers wait.
 */
async function withInstallLock<T>(registry: string, action: () => Promise<T>): Promise<T> {
  const lock = join(registry, "__dirlock");
  try {
    await mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        `A Playwright install holds ${lock}. Retry when it finishes; remove the lock only if no install is running.`,
      );
    throw error;
  }
  const refresh = setInterval(() => {
    const now = new Date();
    void utimes(lock, now, now).catch(() => {});
  }, 2000);
  try {
    return await action();
  } finally {
    clearInterval(refresh);
    await rmdir(lock).catch(() => {});
  }
}

export interface PruneOptions {
  root: string;
  dryRun: boolean;
  /** Also delete revisions that only other projects' live installs registered. */
  includeOtherInstalls?: boolean;
  registry?: string;
  worktrees?: string[];
  processes?: () => Promise<Map<number, string[]>>;
}

export interface PruneReport {
  registry: string;
  dryRun: boolean;
  worktrees: string[];
  versions: Record<string, string[]>;
  keep: { name: string; bytes: number; reasons: string[] }[];
  remove: { name: string; bytes: number; registeredBy: string[]; removed: boolean }[];
  /** What `includeOtherInstalls` would also remove (empty when it is set). */
  heldByOtherInstalls: { name: string; bytes: number; registeredBy: string[] }[];
  bytesBefore: number;
  bytesFreed: number;
  bytesHeldByOtherInstalls: number;
}

/**
 * Remove Playwright browser revisions that no playwright-core version linked by
 * any worktree of this repository uses and, unless `includeOtherInstalls`, no
 * other live Playwright install registered. Refuses when a linked version cannot be
 * resolved to an installed browsers.json, because its needs would be guessed.
 */
export async function pruneBrowsers(options: PruneOptions): Promise<PruneReport> {
  const configured = options.registry ?? browsersRegistry();
  if (!configured)
    throw new Error(
      "PLAYWRIGHT_BROWSERS_PATH=0 keeps browsers per package; nothing shared to prune.",
    );
  // /proc reports resolved paths; match against the resolved registry.
  const registry = await realpath(configured).catch(() => resolve(configured));
  const worktrees = options.worktrees ?? (await repositoryWorktrees(options.root));
  const referenced = new Map<string, Set<string>>();
  const candidates: string[] = [];
  for (const worktree of worktrees) {
    const { versions, packages } = await worktreePlaywright(worktree);
    for (const version of versions)
      referenced.set(version, (referenced.get(version) ?? new Set()).add(worktree));
    candidates.push(...packages);
  }
  // Other live installs: Playwright records each installing package under .links.
  const links = join(registry, ".links");
  const installs: PlaywrightPackage[] = [];
  for (const link of await readdir(links).catch(() => [])) {
    const target = (await readText(join(links, link)))?.trim();
    const found = target ? await readPackage(target) : undefined;
    if (found) installs.push(found);
  }
  const byVersion = new Map<string, PlaywrightPackage>();
  for (const found of [
    ...(await Promise.all(candidates.map(readPackage))).filter((item) => item !== undefined),
    ...installs,
  ])
    if (!byVersion.has(found.version)) byVersion.set(found.version, found);
  const unresolved = [...referenced.keys()].filter((version) => !byVersion.has(version));
  if (unresolved.length)
    throw new Error(
      `Cannot read browsers.json for playwright-core ${unresolved.join(", ")} (linked by ${unresolved
        .flatMap((version) => [...referenced.get(version)!])
        .join(", ")}). Run vp install there first; refusing to guess which revisions it needs.`,
    );
  const needed = new Map<string, string[]>();
  for (const version of referenced.keys())
    for (const name of byVersion.get(version)!.directories)
      needed.set(name, [...(needed.get(name) ?? []), `playwright-core@${version}`]);
  const ours = new Set([...referenced.keys()].map((version) => byVersion.get(version)!.path));
  const otherInstalls = new Map<string, string[]>();
  for (const install of installs) {
    if (ours.has(install.path) || referenced.has(install.version)) continue;
    for (const name of install.directories)
      otherInstalls.set(name, [
        ...(otherInstalls.get(name) ?? []),
        `${install.path} (${install.version})`,
      ]);
  }

  const scan = options.processes ?? processPaths;
  const versions = Object.fromEntries(
    [...referenced].map(([version, trees]) => [version, [...trees].sort()]),
  );
  const prune = async (): Promise<PruneReport> => {
    const entries = await readdir(registry).catch(() => []);
    const plan = planPrune({
      entries,
      needed,
      inUse: inUseBy(registry, await scan()),
      otherInstalls,
      includeOtherInstalls: options.includeOtherInstalls ?? false,
    });
    const report: PruneReport = {
      registry,
      dryRun: options.dryRun,
      worktrees,
      versions,
      keep: [],
      remove: [],
      heldByOtherInstalls: [],
      bytesBefore: 0,
      bytesFreed: 0,
      bytesHeldByOtherInstalls: 0,
    };
    for (const name of entries) report.bytesBefore += await directorySize(join(registry, name));
    for (const { name, reasons } of plan.keep)
      report.keep.push({ name, reasons, bytes: await directorySize(join(registry, name)) });
    for (const { name, registeredBy } of plan.heldByOtherInstalls) {
      const bytes = await directorySize(join(registry, name));
      report.heldByOtherInstalls.push({ name, bytes, registeredBy });
      report.bytesHeldByOtherInstalls += bytes;
    }
    for (const { name, registeredBy } of plan.remove) {
      const bytes = await directorySize(join(registry, name));
      let removed = false;
      if (!options.dryRun) removed = await removeRevision(registry, name, scan);
      report.remove.push({ name, bytes, registeredBy, removed });
      if (removed || options.dryRun) report.bytesFreed += bytes;
    }
    return report;
  };
  if (options.dryRun || !(await exists(registry))) return prune();
  return withInstallLock(registry, prune);
}

/**
 * Rename aside first, so a launch racing the prune fails cleanly instead of
 * running a half-deleted browser; re-check for users of the renamed path, then delete.
 */
async function removeRevision(
  registry: string,
  name: string,
  scan: () => Promise<Map<number, string[]>>,
): Promise<boolean> {
  const source = join(registry, name);
  const trash = name.startsWith(TRASH) ? source : join(registry, `${TRASH}${name}.${process.pid}`);
  if (trash !== source) await rename(source, trash);
  if (inUseBy(registry, await scan()).has(trash.slice(registry.length + 1))) {
    if (trash !== source) await rename(trash, source);
    return false;
  }
  await rm(trash, { recursive: true, force: true });
  return true;
}
