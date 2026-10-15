// Replays recent main commits through the agents' E2E selection and estimates
// what each one's `vp run ready` E2E stage would cost, from the measured
// scenario times of a complete run (its artifacts/e2e.json):
//
//   node tools/agent/ready-e2e-replay.ts --timings <run>/artifacts/e2e.json [--commits 80] [--ref origin/main]
//
// Approximations: each first-parent commit is replayed alone against its first
// parent; whether ready runs E2E at all mirrors ready-plan's rule (production
// website/CLI paths or a full-coverage fallback); a run costs the fixed
// environment stages (from timings.json beside e2e.json, when present) plus its
// scenarios' summed times, and the mirror runs concurrently with them.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { AGENTS_FULL, e2eScenarioNames, e2eTarget, selectReadyE2E } from "./ready-e2e.ts";

const exec = promisify(execFile);
const root = join(import.meta.dirname, "../..");
const { values } = parseArgs({
  options: {
    timings: { type: "string" },
    commits: { type: "string", default: "80" },
    ref: { type: "string", default: "origin/main" },
  },
});
if (!values.timings)
  throw new Error("Pass --timings <run>/artifacts/e2e.json from a complete run.");

const report = JSON.parse(await readFile(values.timings, "utf8")) as {
  scenario: string;
  elapsedMs: number;
}[];
const seconds = new Map(report.map((entry) => [entry.scenario, entry.elapsedMs / 1000]));
const missing = e2eScenarioNames.filter((name) => !seconds.has(name));
if (missing.length) console.warn(`No measured time (counted as 0 s): ${missing.join(", ")}`);
const stages = await readFile(join(dirname(values.timings), "timings.json"), "utf8")
  .then((text) => JSON.parse(text) as { stage: string; elapsedMs: number }[])
  .catch(() => []);
const fixed =
  stages
    .filter((stage) => stage.stage !== "scenarios" && stage.stage !== "shutdown")
    .reduce((sum, stage) => sum + stage.elapsedMs / 1000, 0) || 77;
const mirror = await readFile(join(dirname(values.timings), "mirror-e2e.json"), "utf8")
  .then((text) => JSON.parse(text) as { startedAt: string; finishedAt: string })
  .then(({ startedAt, finishedAt }) => (Date.parse(finishedAt) - Date.parse(startedAt)) / 1000)
  .catch(() => 64);

const git = async (args: string[]) =>
  (await exec("git", args, { cwd: root, maxBuffer: 64 << 20 })).stdout;

// ready-plan's classification, reduced to "does ready run E2E for this change".
const workspaces = [
  "apps/cli",
  "tools/agent",
  "tools/preview",
  "tools/remote",
  "apps/website",
  "apps/site",
  "packages/formats",
  "packages/testing",
  "packages/utils",
];
// As ready-plan.ts's documentation().
const documentation = (path: string) =>
  /^(?:README|AGENTS|CONTRIBUTING|CHANGELOG|CLAUDE|DESIGN|PRODUCT|SELF-HOSTING|ATTRIBUTIONS)\.md$/.test(
    path,
  ) ||
  path === "LICENSE" ||
  workspaces.some((w) =>
    new RegExp(`^${w}/(?:README|AGENTS|CONTRIBUTING|CHANGELOG)\\.md$`).test(path),
  );
const agentConfig = (path: string) =>
  /^\.claude\/(?:agents|rules|skills)\/.+\.md$/.test(path) ||
  /^\.agents\/skills\/.+\.md$/.test(path) ||
  path === ".claude/settings.json";
const testOnly = (path: string) =>
  /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) || /^apps\/cli\/tests\/.*\.rs$/.test(path);
function readyRunsE2E(changed: readonly string[]): boolean {
  return changed.some((path) => {
    if (documentation(path) || agentConfig(path)) return false;
    const workspace = workspaces.find((w) => path.startsWith(`${w}/`));
    if (!workspace || path === `${workspace}/package.json`) return true;
    if (testOnly(path) || workspace === "packages/testing") return false;
    // Production changes that reach the website or gm (formats/utils are their dependencies).
    return !["tools/preview", "apps/site"].includes(workspace);
  });
}

const commits = (
  await git(["rev-list", "--first-parent", "-n", values.commits!, values.ref!])
).split("\n");
const rows: { sha: string; subject: string; count: number; cost: number; trigger: string }[] = [];
for (const sha of commits.filter(Boolean)) {
  const subject = (await git(["show", "-s", "--format=%s", sha])).trim();
  const changed = (
    await git(["diff-tree", "-r", "--no-renames", "--name-only", "--no-commit-id", `${sha}^1`, sha])
  )
    .split("\n")
    .filter(Boolean);
  const selection = readyRunsE2E(changed) ? selectReadyE2E(changed, false) : null;
  const names = selection?.scenarios ?? [];
  const runs = selection !== null && (names.length > 0 || selection.mirror);
  const scenarioSeconds = names.reduce((sum, name) => sum + (seconds.get(name) ?? 0), 0);
  const cost = runs ? fixed + Math.max(scenarioSeconds, selection!.mirror ? mirror : 0) : 0;
  const widening = changed.find((path) => e2eTarget(path) === AGENTS_FULL);
  const contributing = changed.filter((path) => {
    const target = e2eTarget(path);
    return target !== AGENTS_FULL && Boolean(target.areas?.length || target.scenarios?.length);
  });
  const trigger = !selection
    ? "no E2E (ready-plan)"
    : widening
      ? `agents' full set: ${widening}`
      : [...new Set(contributing.map(prefix))].join(" ") ||
        (selection.mirror ? "mirror only" : "nothing selected");
  rows.push({
    sha: sha.slice(0, 8),
    subject: subject.slice(0, 60),
    count: names.length,
    cost,
    trigger,
  });
}

function prefix(path: string): string {
  const parts = path.split("/");
  if (path.startsWith("apps/website/worker/") || path.startsWith("apps/website/shared/"))
    return parts.slice(0, 4).join("/") + (parts.length > 4 ? "/" : "");
  return parts.slice(0, Math.min(parts.length, 2)).join("/") + (parts.length > 2 ? "/" : "");
}

const minutes = (s: number) => `${(s / 60).toFixed(1)} min`;
for (const row of rows)
  console.log(
    `${row.sha}  ${String(row.count).padStart(2)} scenarios  ${minutes(row.cost).padStart(8)}  ${row.subject}  [${row.trigger}]`,
  );
const costs = rows.map((row) => row.cost).sort((a, b) => a - b);
const quantile = (q: number) => costs[Math.min(costs.length - 1, Math.ceil(q * costs.length) - 1)]!;
const counts = rows.map((row) => row.count).sort((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      commits: rows.length,
      fixedSeconds: Math.round(fixed),
      noE2E: rows.filter((row) => row.cost === 0).length,
      agentsFullSet: rows.filter((row) => row.trigger.startsWith("agents' full set")).length,
      scenarios: { median: counts[Math.ceil(counts.length / 2) - 1], max: counts.at(-1) },
      e2eMinutes: {
        median: +(quantile(0.5) / 60).toFixed(1),
        p90: +(quantile(0.9) / 60).toFixed(1),
        max: +(costs.at(-1)! / 60).toFixed(1),
        mean: +(costs.reduce((a, b) => a + b, 0) / costs.length / 60).toFixed(1),
      },
    },
    null,
    2,
  ),
);
