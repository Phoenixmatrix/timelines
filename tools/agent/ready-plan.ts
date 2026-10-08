import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

export interface ReadyOptions {
  all: boolean;
  dryRun: boolean;
  base: string;
}

export interface ReadyPlan {
  base: string | null;
  changed: string[];
  full: boolean;
  reasons: string[];
  gates: Array<{ name: string; binary: string; args: string[]; cwd: "root" | "website" }>;
  e2e: boolean;
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
  "apps/website",
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
    gate("check", ["check"]),
    task("cli-check", "cli#check"),
    task("types", "@gitmatrix/agent#typecheck"),
    task("preview-types", "@gitmatrix/preview#typecheck"),
    task("formats-types", "@gitmatrix/formats#typecheck"),
    task("testing-types", "@gitmatrix/testing#typecheck"),
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
    reasons: [],
    gates: [],
    e2e: false,
  };
  const full = (reason: string): ReadyPlan => {
    plan.full = true;
    plan.reasons.push(
      reason,
      "Full coverage: all workspace checks, tests, builds and existing non-AI E2E/mirror.",
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
  } catch (error) {
    return full(
      `Cannot discover changes against ${options.base}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (options.all) return full("--all explicitly requested.");
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
    if (documentation(path)) continue;
    const workspace = WORKSPACES.find((prefix) => path.startsWith(`${prefix}/`));
    if (!workspace) return full(`Unclassified or global path: ${path}`);
    if (path === `${workspace}/package.json`)
      return full(`Workspace task/dependency configuration changed: ${path}`);
    if (workspace === "tools/agent" && !testOnly(path))
      return full(`Shared harness lifecycle or readiness implementation changed: ${path}`);
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
  if (stylesheetOnly)
    plan.reasons.push(
      "Content-only audited stylesheets: retain whole website tests/build/types and frontend E2E; omit unrelated implicit agent/preview consumers.",
    );
  plan.gates.push(gate("check", ["check"]));
  const labels: Record<Workspace, string> = {
    "apps/cli": "cli",
    "tools/agent": "agent",
    "tools/preview": "preview",
    "apps/website": "website",
    "packages/formats": "formats",
    "packages/testing": "testing",
    "packages/utils": "utils",
  };
  for (const workspace of WORKSPACES) {
    if (!affected.has(workspace)) continue;
    const manifest = manifests.get(workspace)!;
    const label = labels[workspace];
    if (workspace === "apps/cli") plan.gates.push(task("cli-check", "cli#check"));
    if (manifest.scripts?.typecheck && workspace !== "apps/website")
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
      : "No executable changes: only the mandatory root check (and missing bindings).",
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
