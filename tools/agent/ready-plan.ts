import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";

export interface ReadyOptions {
  all: boolean;
  dryRun: boolean;
  base: string;
  /**
   * `ci-tests`: remote CI's test selection. Changes under tools/agent and tools/remote are
   * classified like any other workspace's instead of forcing full coverage; the full suite
   * runs on the main watcher.
   */
  scope?: "ci-tests";
}

export interface ReadyPlan {
  base: string | null;
  changed: string[];
  full: boolean;
  /**
   * Explicit `--all`, or no reliable change list: E2E runs every scenario,
   * main-only ones included. Other full-coverage fallbacks keep the complete
   * code gates but select E2E journeys from the changed paths.
   */
  e2eAll: boolean;
  reasons: string[];
  gates: Array<{ name: string; binary: string; args: string[]; cwd: "root" | "website" }>;
  e2e: boolean;
  /** Workspaces containing a changed path directly, not only through dependency propagation. */
  direct: string[];
}

export function parseReadyOptions(args: readonly string[]): ReadyOptions {
  const options: ReadyOptions = { all: false, dryRun: false, base: "origin/main" };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    const flag = argument.startsWith("--base=") ? "--base" : argument;
    if (!["--all", "--dry-run", "--base"].includes(flag))
      throw new Error(`Unknown ready option: ${argument}`);
    if (seen.has(flag)) throw new Error(`Duplicate ready option: ${flag}`);
    seen.add(flag);
    if (flag === "--all") options.all = true;
    else if (flag === "--dry-run") options.dryRun = true;
    else {
      const value = argument === "--base" ? args[++i] : argument.slice("--base=".length);
      if (!value || value.startsWith("-") || value.includes("\0") || value.trim() !== value)
        throw new Error("--base requires a nonempty Git ref");
      options.base = value;
    }
  }
  return options;
}

// Keep the workspace boundary explicit: new workspaces must first get a readiness policy.
// Dependency edges and available tasks come from manifests, not a second task registry.
const WORKSPACES = [
  "apps/cli",
  "tools/agent",
  "tools/preview",
  "tools/remote",
  "apps/website",
  "apps/site",
  "packages/formats",
  "packages/testing",
  "packages/utils",
] as const;
type Workspace = (typeof WORKSPACES)[number];
interface Manifest {
  name: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export const labels: Record<Workspace, string> = {
  "apps/cli": "cli",
  "tools/agent": "agent",
  "tools/preview": "preview",
  "tools/remote": "remote",
  "apps/website": "website",
  "apps/site": "site",
  "packages/formats": "formats",
  "packages/testing": "testing",
  "packages/utils": "utils",
};

const exec = promisify(execFile);
const gate = (name: string, args: string[]): ReadyPlan["gates"][number] => ({
  name,
  binary: "vp",
  args,
  cwd: "root",
});
const bindings = (): ReadyPlan["gates"][number] => ({
  name: "bindings",
  binary: "cf",
  args: ["workers", "types"],
  cwd: "website",
});
const task = (name: string, target: string) => gate(name, ["run", "--no-cache", target]);

function fullGates(): ReadyPlan["gates"] {
  return [
    task("website-types", "website#typecheck"),
    task("remote-types", "@gitmatrix/remote#typecheck"),
    gate("check", ["check"]),
    task("cli-check", "cli#check"),
    task("types", "@gitmatrix/agent#typecheck"),
    task("preview-types", "@gitmatrix/preview#typecheck"),
    task("formats-types", "@gitmatrix/formats#typecheck"),
    task("testing-types", "@gitmatrix/testing#typecheck"),
    task("site-types", "site#typecheck"),
    gate("tests", ["run", "-r", "--concurrency-limit", "1", "--no-cache", "test"]),
    gate("build", ["run", "-r", "--concurrency-limit", "1", "--no-cache", "build"]),
  ];
}

function documentation(path: string): boolean {
  // Only human-facing documents at known roots; assets and nested Markdown can be runtime inputs.
  return (
    /^(?:README|AGENTS|CONTRIBUTING|CHANGELOG)\.md$/.test(path) ||
    WORKSPACES.some((workspace) =>
      new RegExp(`^${workspace}/(?:README|AGENTS|CONTRIBUTING|CHANGELOG)\\.md$`).test(path),
    )
  );
}

function agentConfig(path: string): boolean {
  // Coding agents' instructions, subagents, skills and harness settings: nothing builds from or
  // tests them, and the mandatory root check still formats and lints them. Scripts and hooks
  // beside them are not covered.
  return (
    /^\.claude\/(?:agents|rules|skills)\/.+\.md$/.test(path) ||
    /^\.agents\/skills\/.+\.md$/.test(path) ||
    path === ".claude/settings.json"
  );
}

function testOnly(path: string): boolean {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) || /^apps\/cli\/tests\/.*\.rs$/.test(path);
}

const STYLESHEETS: Record<string, true> = {
  "apps/website/src/styles/app.css": true,
  "apps/website/src/styles/tokens.css": true,
  "apps/website/src/styles/matrixkit.css": true,
};

// Freeze all at-rule inputs, not just single-line @imports. Escaped spellings
// are deliberately unaudited; changed imports/plugins/sources widen coverage.
function stylesheetInputs(text: string): string | null {
  if (text.includes("\\")) return null;
  const tokens =
    text.match(
      /\/\*[\s\S]*?\*\/|"[^"]*"|'[^']*'|@(?:[^;{}"'/]|\/(?!\*)|\/\*[\s\S]*?\*\/|"[^"]*"|'[^']*')*(?:[;{]|$)|url\((?:[^)"']|"[^"]*"|'[^']*')*\)/gi,
    ) ?? [];
  return JSON.stringify(tokens.filter((token) => token.startsWith("@") || /^url\(/i.test(token)));
}

/** Read-only planning. Failed discovery always selects full coverage, never an empty change set. */
export async function readinessPlan(root: string, options: ReadyOptions): Promise<ReadyPlan> {
  const plan: ReadyPlan = {
    base: null,
    changed: [],
    full: false,
    e2eAll: false,
    reasons: [],
    gates: [],
    e2e: false,
    direct: [],
  };
  const full = (reason: string, e2eAll = false): ReadyPlan => {
    plan.full = true;
    plan.e2eAll = e2eAll;
    plan.reasons.push(
      reason,
      e2eAll
        ? "Full coverage: all workspace checks, tests, builds and every non-AI E2E scenario/mirror."
        : "Full coverage: all workspace checks, tests and builds; E2E journeys selected from changed paths.",
    );
    plan.gates = fullGates();
    plan.e2e = true;
    return plan;
  };
  const git = async (args: string[]) =>
    (
      await exec("git", args, {
        cwd: root,
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 32 * 1024 * 1024,
      })
    ).stdout;
  try {
    // Resolve before merge-base so a supplied ref cannot be interpreted as a Git option.
    const base = (
      await git(["rev-parse", "--verify", "--end-of-options", `${options.base}^{commit}`])
    ).trim();
    plan.base = (await git(["merge-base", base, "HEAD"])).trim();
    const lists = await Promise.all([
      git(["diff", "--name-only", "--no-renames", "-z", plan.base, "HEAD", "--"]),
      git(["diff", "--cached", "--name-only", "--no-renames", "-z", "HEAD", "--"]),
      git(["diff", "--name-only", "--no-renames", "-z", "--"]),
      git(["ls-files", "--others", "--exclude-standard", "-z"]),
    ]);
    plan.changed = [...new Set(lists.flatMap((list) => list.split("\0").filter(Boolean)))].sort();
    plan.direct = WORKSPACES.filter((workspace) =>
      plan.changed.some(
        (path) => path.startsWith(`${workspace}/`) && !documentation(path) && !agentConfig(path),
      ),
    );
  } catch (error) {
    return full(
      `Cannot discover changes against ${options.base}: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
  if (options.all) return full("--all explicitly requested.", true);
  let stylesheetOnly =
    plan.changed.length > 0 && plan.changed.every((path) => Object.hasOwn(STYLESHEETS, path));
  if (stylesheetOnly) {
    try {
      // Check every boundary independently: an index deletion restored in the
      // worktree, or an import change later reverted, must not look content-only.
      for (const range of [[plan.base!, "HEAD"], ["--cached", "HEAD"], []]) {
        if (
          await git([
            "diff",
            ...range,
            "--name-only",
            "--no-renames",
            "-z",
            "--diff-filter=ADRTUXB",
            "--",
          ])
        )
          stylesheetOnly = false;
      }
      for (const path of plan.changed) {
        const versions = await Promise.all([
          git(["show", `${plan.base}:${path}`]),
          git(["show", `HEAD:${path}`]),
          git(["show", `:${path}`]),
          readFile(join(root, path), "utf8"),
        ]);
        const inputs = versions.map(stylesheetInputs);
        if (inputs[0] === null || inputs.some((input) => input !== inputs[0]))
          stylesheetOnly = false;
      }
    } catch {
      stylesheetOnly = false;
    }
  }

  const affected = new Set<Workspace>();
  const production = new Set<Workspace>();
  for (const path of plan.changed) {
    if (documentation(path) || agentConfig(path)) continue;
    const workspace = WORKSPACES.find((prefix) => path.startsWith(`${prefix}/`));
    if (!workspace) return full(`Unclassified or global path: ${path}`);
    if (path === `${workspace}/package.json`)
      return full(`Workspace task/dependency configuration changed: ${path}`);
    if (workspace === "tools/agent" && !testOnly(path) && options.scope !== "ci-tests")
      return full(`Shared harness lifecycle or readiness implementation changed: ${path}`);
    if (workspace === "tools/remote" && !testOnly(path) && options.scope !== "ci-tests")
      return full(`Shared remote execution backend changed: ${path}`);
    affected.add(workspace);
    if (!testOnly(path) && workspace !== "packages/testing") production.add(workspace);
  }

  let manifests: Map<Workspace, Manifest>;
  try {
    manifests = new Map(
      await Promise.all(
        WORKSPACES.map(async (workspace) => {
          const manifest: Manifest = JSON.parse(
            await readFile(join(root, workspace, "package.json"), "utf8"),
          );
          if (typeof manifest.name !== "string" || !manifest.scripts)
            throw new Error(`Invalid workspace manifest: ${workspace}`);
          return [workspace, manifest] as const;
        }),
      ),
    );
  } catch (error) {
    return full(
      `Cannot load workspace task graph: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }

  const dependencies = new Map<Workspace, Set<Workspace>>();
  for (const [workspace, manifest] of manifests) {
    const names = new Set(
      Object.keys({
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.peerDependencies,
        ...manifest.optionalDependencies,
      }),
    );
    dependencies.set(
      workspace,
      new Set(
        [...manifests].filter(([, dependency]) => names.has(dependency.name)).map(([path]) => path),
      ),
    );
  }
  // Relative TS imports are not represented by package.json (including preview's typecheck launcher).
  if (!stylesheetOnly) {
    dependencies.get("tools/agent")!.add("apps/website");
    dependencies.get("tools/preview")!.add("apps/website");
  }
  dependencies.get("tools/preview")!.add("tools/agent");
  dependencies.get("tools/remote")!.add("tools/agent");
  // The agent tests import the remote runtime and copy its Worker configuration, and remote CI
  // runs a tools/remote change by test selection alone; ready's full fallback covers it locally.
  if (options.scope === "ci-tests") dependencies.get("tools/agent")!.add("tools/remote");
  // The site's gm reference is checked against gm's manifest (apps/cli/src/meta.rs).
  dependencies.get("apps/site")!.add("apps/cli");
  const propagate = (selected: Set<Workspace>) => {
    let added = true;
    while (added) {
      added = false;
      for (const [workspace, deps] of dependencies) {
        if (!selected.has(workspace) && [...deps].some((dependency) => selected.has(dependency))) {
          selected.add(workspace);
          added = true;
        }
      }
    }
  };
  // Test files cannot change consumers' runtime, but shared testing helpers affect consumer tests/types.
  const shared = new Set<Workspace>();
  for (const workspace of affected)
    if (production.has(workspace) || workspace === "packages/testing") shared.add(workspace);
  propagate(shared);
  for (const workspace of shared) affected.add(workspace);
  propagate(production);

  let hasBindings = true;
  try {
    await access(join(root, "apps/website/.cloudflare/types/index.d.ts"));
  } catch {
    hasBindings = false;
  }
  const websiteTypes =
    affected.has("apps/website") && manifests.get("apps/website")!.scripts?.typecheck;
  if (websiteTypes) {
    plan.gates.push(task("website-types", `${manifests.get("apps/website")!.name}#typecheck`));
    plan.reasons.push("Website typecheck generates bindings before root check and consumer types.");
  } else if (!hasBindings) {
    plan.gates.push(bindings());
    plan.reasons.push("Generate missing bindings required by root type-aware vp check.");
  }
  // Root type-aware lint includes the remote Worker even for otherwise narrow changes.
  // Its typecheck generates credential-free bindings before checking the Worker contract.
  plan.gates.push(task("remote-types", "@gitmatrix/remote#typecheck"));
  if (stylesheetOnly)
    plan.reasons.push(
      "Content-only audited stylesheets: retain whole website tests/build/types and frontend E2E; omit unrelated implicit agent/preview consumers.",
    );
  plan.gates.push(gate("check", ["check"]));
  for (const workspace of WORKSPACES) {
    if (!affected.has(workspace)) continue;
    const manifest = manifests.get(workspace)!;
    const label = labels[workspace];
    if (workspace === "apps/cli") plan.gates.push(task("cli-check", "cli#check"));
    if (manifest.scripts?.typecheck && workspace !== "apps/website" && workspace !== "tools/remote")
      plan.gates.push(
        task(
          workspace === "tools/agent" ? "types" : `${label}-types`,
          `${manifest.name}#typecheck`,
        ),
      );
    if (manifest.scripts?.test) plan.gates.push(task(`${label}-tests`, `${manifest.name}#test`));
    if (production.has(workspace) && manifest.scripts?.build)
      plan.gates.push(task(`${label}-build`, `${manifest.name}#build`));
  }
  plan.e2e = production.has("apps/website") || production.has("apps/cli");
  plan.reasons.push(
    affected.size
      ? `Check/test affected workspaces and transitive consumers: ${[...affected].join(", ")}.`
      : "No executable changes: only mandatory root/remote checks (and missing bindings).",
    production.size
      ? `Build affected production workspaces where a build task exists: ${[...production].join(", ")}.`
      : "Skip builds: only documentation, tests or shared test helpers changed.",
    plan.e2e
      ? "Production app/CLI dependency changes require non-AI E2E selection."
      : "Skip live E2E/mirror: no production app/CLI dependency changes.",
    `Unaffected workspaces skipped: ${WORKSPACES.filter((workspace) => !affected.has(workspace)).join(", ") || "none"}.`,
  );
  return plan;
}

const WEBSITE = "apps/website/";

/** The one README the website's tests read (worker/ci/config.test.ts, as a `?raw` import). */
export const WEBSITE_README = `${WEBSITE}README.md`;

/** Configuration or setup that Vitest's changed-file graph cannot be trusted to follow. */
function websiteConfig(path: string): boolean {
  const relative = path.slice(WEBSITE.length);
  return (
    relative === "vite.config.ts" ||
    relative.startsWith("vite/") ||
    /^tsconfig[^/]*\.json$/.test(basename(relative)) ||
    relative === "worker/testing/runtime.ts"
  );
}

/**
 * Which website tests a change needs when `website-tests` is selected: whether Vitest's
 * `--changed` graph can be trusted for the unit project, and whether browser tests can be
 * affected. Shared by remote CI (ci-test.ts) and local `ready`.
 */
export function websiteTestSelection(changed: string[]): {
  unit: "all" | "changed";
  browser: boolean;
  reasons: string[];
} {
  const web = changed.filter((path) => path.startsWith(WEBSITE));
  const code = web.filter((path) => path !== WEBSITE_README);
  const packages = changed.some((path) => path.startsWith("packages/"));
  // Workspace sources may not be in Vitest's module graph, and fixtures, migrations, seeds,
  // CSS and configuration cannot be traced through imports.
  const traceable =
    web.length > 0 &&
    !packages &&
    web.every((path) => path === WEBSITE_README || /\.tsx?$/.test(path)) &&
    !web.some(websiteConfig);
  // Browser tests run against worker/testing/browser-api.ts, which imports the real Worker
  // routes, so any website source change can affect them. Only a unit test file or the README
  // (read by a unit test) cannot.
  const browser =
    packages ||
    web.length === 0 ||
    (code.length > 0 &&
      !code.every((path) => path.endsWith(".test.ts") && !path.endsWith(".browser.test.tsx")));
  return {
    unit: traceable ? "changed" : "all",
    browser,
    reasons: traceable
      ? []
      : [
          "Website unit tests run in full: a changed path cannot be traced through imports (workspace package, non-TypeScript file, configuration, or no website path).",
        ],
  };
}

/**
 * What local `ready` runs instead of the plan's gates: remote CI runs the tests and builds, so
 * keep the cheap checks and typechecks, plus the tests related to the change. Website unit
 * tests follow Vitest's changed-file graph when every changed path is traceable (else the whole
 * unit project runs), its browser tests are picked by colocated path, and other directly changed
 * workspaces keep their own tests, as do a changed package's consumers. A global or unclassified
 * path, or failed change discovery, keeps the plan's gates unchanged (the same array).
 * `--all` is not slimmed by the caller.
 */
export async function localGates(root: string, plan: ReadyPlan): Promise<ReadyPlan["gates"]> {
  if (plan.base === null) return plan.gates;
  if (
    plan.changed.some(
      (path) =>
        !documentation(path) &&
        !agentConfig(path) &&
        !WORKSPACES.some((workspace) => path.startsWith(`${workspace}/`)),
    )
  )
    return plan.gates;
  const kept = plan.gates.filter(
    ({ name }) => name !== "tests" && name !== "build" && !/-(?:tests|build)$/.test(name),
  );
  const tests: ReadyPlan["gates"] = [];
  const packages = plan.changed.some((path) => path.startsWith("packages/"));
  for (const workspace of WORKSPACES) {
    const label = labels[workspace];
    const direct = plan.direct.includes(workspace);
    if (workspace === "apps/website") {
      if (
        !direct &&
        !plan.changed.includes(WEBSITE_README) &&
        !plan.gates.some(({ name }) => name === "website-tests")
      )
        continue;
      // `vp run website#test` does not forward extra Vitest arguments, so run its script directly.
      const runner = (name: string, args: string[]): ReadyPlan["gates"][number] => ({
        name,
        binary: "node",
        args: ["../../tools/agent/website-tests.ts", ...args],
        cwd: "website",
      });
      tests.push(
        runner(
          "website-tests",
          websiteTestSelection(plan.changed).unit === "changed"
            ? ["--project", "unit", `--changed=${plan.base}`, "--passWithNoTests"]
            : ["--project", "unit"],
        ),
      );
      const browser = new Set<string>();
      for (const path of plan.changed) {
        if (!path.startsWith("apps/website/src/")) continue;
        const relative = path.slice("apps/website/".length);
        if (relative.endsWith(".browser.test.tsx")) {
          if (await exists(join(root, path))) browser.add(relative);
        } else if (/\.(?:ts|tsx|css)$/.test(relative) && !testOnly(relative)) {
          const candidate = relative.replace(/\.[^./]+$/, ".browser.test.tsx");
          if (await exists(join(root, "apps/website", candidate))) browser.add(candidate);
        }
      }
      if (browser.size)
        tests.push(
          runner("website-browser-tests", ["--project", "browser", ...[...browser].sort()]),
        );
      continue;
    }
    const existing = plan.gates.find(({ name }) => name === `${label}-tests`);
    if (existing) {
      if (direct || (packages && workspace !== "apps/cli")) tests.push(existing);
      continue;
    }
    if (!direct || !plan.gates.some(({ name }) => name === "tests")) continue;
    try {
      const manifest: Manifest = JSON.parse(
        await readFile(join(root, workspace, "package.json"), "utf8"),
      );
      if (manifest.scripts?.test) tests.push(task(`${label}-tests`, `${manifest.name}#test`));
    } catch {
      // An unreadable manifest already forced the full plan; its tests run remotely.
    }
  }
  return [...kept, ...tests];
}

/** The plan's reasons once `localGates` has slimmed its gates: coverage lines would be false. */
export function localReasons(reasons: string[]): string[] {
  return [
    ...reasons.filter(
      (reason) =>
        !reason.startsWith("Full coverage:") &&
        !reason.startsWith("Build affected production workspaces") &&
        !reason.startsWith("Skip builds:"),
    ),
    "Local ready runs checks, typechecks, related tests and E2E; remote CI's check, test, build and cli jobs run the rest.",
  ];
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
