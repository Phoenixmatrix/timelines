import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { verifiedBaseline, type VerifiedBaseline } from "./ci-baseline.ts";
import { labels, readinessPlan, websiteTestSelection, WEBSITE_README } from "./ready-plan.ts";

export interface CiTestPlan {
  full: boolean;
  baseline: VerifiedBaseline | null;
  changed: string[];
  reasons: string[];
  /** Workspace labels (not website, not cli) whose `test` task runs. */
  workspaces: string[];
  websiteUnit: "all" | "changed" | "none";
  websiteBrowser: boolean;
}

const WEBSITE_RUNNER = "tools/agent/website-tests.ts";

/**
 * The files the website's `test` script runs on: website-tests.ts and whatever it imports
 * relatively (followed statically, so a new import is covered). A change to one of them can
 * break any website test, so none of Vitest's changed graph applies.
 */
export function websiteRunnerFiles(root: string): string[] {
  const found = new Set<string>([WEBSITE_RUNNER, "tools/agent/heavy.ts"]);
  const queue = [WEBSITE_RUNNER];
  for (let path = queue.pop(); path; path = queue.pop()) {
    let source: string;
    try {
      source = readFileSync(join(root, path), "utf8");
    } catch {
      continue;
    }
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = join(dirname(path), match[1]!);
      if (!found.has(target)) {
        found.add(target);
        queue.push(target);
      }
    }
  }
  return [...found].sort();
}

/**
 * Remote CI's `test` job runs what a change affects, measured against the last verified
 * successful `test` job, not the whole suite: that runs on the main watcher (main-e2e.ts),
 * which files a P0 issue when it fails.
 */
export async function ciTestPlan(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CiTestPlan> {
  const everything = (
    reason: string,
    baseline: VerifiedBaseline | null,
    changed: string[] = [],
  ) => ({
    full: true,
    baseline,
    changed,
    reasons: [reason],
    workspaces: [],
    websiteUnit: "all" as const,
    websiteBrowser: true,
  });
  const verified = await verifiedBaseline(root, env);
  if ("reason" in verified) return everything(verified.reason, null);
  const { baseline } = verified;
  const plan = await readinessPlan(root, {
    all: false,
    dryRun: true,
    base: baseline.commit,
    scope: "ci-tests",
  });
  if (plan.full) return everything(plan.reasons[0], baseline, plan.changed);

  const gates = new Set(plan.gates.map((gate) => gate.name));
  const workspaces = Object.values(labels).filter(
    (label) => label !== "website" && label !== "cli" && gates.has(`${label}-tests`),
  );
  const reasons: string[] = [];
  let websiteUnit: CiTestPlan["websiteUnit"] = "none";
  let websiteBrowser = false;
  const runner = new Set(websiteRunnerFiles(root));
  if (plan.changed.some((path) => runner.has(path))) {
    websiteUnit = "all";
    websiteBrowser = true;
    reasons.push("The website's test runner changed: every website test runs.");
  } else if (gates.has("website-tests") || plan.changed.includes(WEBSITE_README)) {
    // The README is documentation to the plan, but a unit test reads it (as a `?raw` import).
    const selection = websiteTestSelection(plan.changed);
    websiteUnit = selection.unit;
    websiteBrowser = selection.browser;
    reasons.push(...selection.reasons);
  }
  return {
    full: false,
    baseline,
    changed: plan.changed,
    reasons: [...plan.reasons, ...reasons],
    workspaces,
    websiteUnit,
    websiteBrowser,
  };
}

function manifestName(root: string, label: string): string {
  const workspace = Object.entries(labels).find(([, value]) => value === label)![0];
  return JSON.parse(readFileSync(join(root, workspace, "package.json"), "utf8")).name;
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, "../..");
  const plan = await ciTestPlan(root);
  console.log(JSON.stringify({ event: "ci.test.plan", ...plan }));
  if (!process.argv.includes("--plan")) {
    const run = (binary: string, args: string[], cwd = root) =>
      execFileSync(binary, args, { cwd, stdio: "inherit" });
    if (plan.full) {
      run("vp", ["run", "--filter", "!cli", "--concurrency-limit", "1", "--no-cache", "test"]);
    } else {
      for (const label of plan.workspaces)
        run("vp", ["run", "--no-cache", `${manifestName(root, label)}#test`]);
      const website = join(root, "apps/website");
      const tests = (args: string[]) =>
        run("node", ["../../tools/agent/website-tests.ts", ...args], website);
      // website-tests.ts retries a crashed browser run only for a lone `--project browser`
      // (or no filters at all), so the projects run apart unless the whole suite is wanted.
      if (plan.websiteUnit === "all" && plan.websiteBrowser) tests([]);
      else {
        if (plan.websiteUnit !== "none")
          tests([
            "--project",
            "unit",
            "--passWithNoTests",
            ...(plan.websiteUnit === "changed" ? [`--changed=${plan.baseline!.commit}`] : []),
          ]);
        if (plan.websiteBrowser) tests(["--project", "browser"]);
      }
    }
  }
}
