// `vp run ready --resume`: which gate and E2E verdicts an earlier run of this worktree
// can stand for, so a rerun after a failure repeats only what failed, was not reached, or
// whose inputs changed. The decisions are pure; main.ts supplies the plan and the files.
//
// The rules that keep reuse honest:
//
// - A verdict is the last attempt of one gate or scenario: its fingerprint, the merge base,
//   outcome, time and evidence. Only a passed last attempt with the same merge base and
//   fingerprint, under 24 hours old, is reused.
// - A gate's fingerprint covers the merge base, its binary, argv and working directory, and
//   the content of every changed path in its workspace or the workspaces it depends on.
//   Paths outside every workspace (root configuration, lockfile, prose) count for every gate.
//   The `bindings` gate is never reused: it is selected because the types are missing now.
// - A scenario's fingerprint covers the changed paths whose E2E target selects it or one of
//   its prerequisites; agents' full set (AGENTS_FULL) counts for every scenario. A scenario
//   that runs brings its prerequisites, reused or not: the environment is always fresh, so
//   only verdicts are reused, never state. The mirror stage needs only the seed; its
//   fingerprint covers the changed paths that select it (git transport, agents' full set).
// - An unreadable history, or one recorded for another worktree, reuses nothing.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { privateJson } from "./environment.ts";
import {
  AGENTS_FULL,
  e2eTarget,
  expandE2EScenarios,
  scenarioAreas,
  selectsMirror,
  type ScenarioName,
} from "./ready-e2e.ts";
import { labels, type ReadyPlan } from "./ready-plan.ts";

/** Older verdicts are ignored: the machine, toolchain and remote services move on. */
export const MAX_AGE_MS = 24 * 60 * 60_000;

export type Kind = "gate" | "scenario" | "mirror";

export interface Attempt {
  kind: Kind;
  name: string;
  fingerprint: string;
  base: string | null;
  outcome: "passed" | "failed";
  finishedAt: string;
  /** The gate's log, or the run's copy of e2e.json or mirror-e2e.json. */
  evidence: string;
}

export interface ReadyHistory {
  /** The worktree that recorded these attempts. */
  root: string;
  /** The last attempt of each gate, scenario and the mirror, by `${kind}:${name}`. */
  attempts: Record<string, Attempt>;
}

export function historyPath(root: string): string {
  return join(root, ".gitmatrix-agent", "ready", "history.json");
}

/** The history, or why it cannot be used (missing is simply empty). */
export function parseHistory(
  text: string | null,
  root: string,
): { history: ReadyHistory } | { problem: string } {
  if (text === null) return { history: { root, attempts: {} } };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { problem: "the ready history is unreadable" };
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("root" in value) ||
    typeof value.root !== "string" ||
    !("attempts" in value) ||
    !value.attempts ||
    typeof value.attempts !== "object"
  )
    return { problem: "the ready history is unreadable" };
  if (value.root !== root)
    return { problem: `the ready history was recorded in another worktree (${value.root})` };
  const attempts: Record<string, Attempt> = {};
  for (const [key, attempt] of Object.entries(value.attempts as Record<string, unknown>)) {
    if (
      !attempt ||
      typeof attempt !== "object" ||
      !("kind" in attempt) ||
      (attempt.kind !== "gate" && attempt.kind !== "scenario" && attempt.kind !== "mirror") ||
      !("name" in attempt) ||
      typeof attempt.name !== "string" ||
      key !== `${attempt.kind}:${attempt.name}` ||
      !("fingerprint" in attempt) ||
      typeof attempt.fingerprint !== "string" ||
      !("base" in attempt) ||
      (attempt.base !== null && typeof attempt.base !== "string") ||
      !("outcome" in attempt) ||
      (attempt.outcome !== "passed" && attempt.outcome !== "failed") ||
      !("finishedAt" in attempt) ||
      typeof attempt.finishedAt !== "string" ||
      !("evidence" in attempt) ||
      typeof attempt.evidence !== "string"
    )
      return { problem: "the ready history is unreadable" };
    attempts[key] = attempt as Attempt;
  }
  return { history: { root, attempts } };
}

export async function readHistory(
  root: string,
): Promise<{ history: ReadyHistory } | { problem: string }> {
  let text: string | null;
  try {
    text = await readFile(historyPath(root), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      return { problem: `the ready history is unreadable (${String(error)})` };
    text = null;
  }
  return parseHistory(text, root);
}

/** Each attempt replaces its gate's or scenario's last one; expired attempts are dropped. */
export function recordAttempts(
  history: ReadyHistory | null,
  root: string,
  attempts: readonly Attempt[],
  now = Date.now(),
): ReadyHistory {
  const merged: Record<string, Attempt> = {};
  for (const [key, attempt] of Object.entries(history?.root === root ? history.attempts : {}))
    if (fresh(attempt, now)) merged[key] = attempt;
  for (const attempt of attempts) merged[`${attempt.kind}:${attempt.name}`] = attempt;
  return { root, attempts: merged };
}

export async function writeHistory(root: string, history: ReadyHistory): Promise<void> {
  await privateJson(historyPath(root), history);
}

function fresh(attempt: Attempt, now: number): boolean {
  const age = now - Date.parse(attempt.finishedAt);
  return age >= 0 && age < MAX_AGE_MS;
}

/** sha256 of each path's working-tree content; a missing path is "deleted". */
export async function contentHashes(
  root: string,
  paths: readonly string[],
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const path of paths) {
    const content = await readFile(join(root, path)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "deleted" as const;
      if (error.code === "EISDIR") return "directory" as const;
      throw error;
    });
    hashes[path] =
      typeof content === "string" ? content : createHash("sha256").update(content).digest("hex");
  }
  return hashes;
}

const byLabel = new Map(Object.entries(labels).map(([workspace, label]) => [label, workspace]));

/** The workspace whose code a gate checks, or null when it covers the whole repository. */
export function gateWorkspace(name: string): string | null {
  if (name === "types") return "tools/agent";
  if (name === "bindings") return "apps/website";
  const label = /^([a-z]+)-(?:types|tests|build|check|readme-tests|browser-tests)$/.exec(name)?.[1];
  return (label && byLabel.get(label)) || null;
}

function workspaceOf(path: string): string | null {
  return Object.keys(labels).find((workspace) => path.startsWith(`${workspace}/`)) ?? null;
}

/** The changed paths a gate reads: null `dependencies` (no task graph) means all of them. */
export function gatePaths(
  name: string,
  changed: readonly string[],
  dependencies: ReadyPlan["dependencies"],
): string[] {
  const workspace = gateWorkspace(name);
  if (!workspace || !dependencies?.[workspace]) return [...changed];
  const closure = new Set([workspace, ...dependencies[workspace]]);
  return changed.filter((path) => {
    const owner = workspaceOf(path);
    return owner === null || closure.has(owner);
  });
}

function digest(
  base: string | null,
  header: string,
  paths: readonly string[],
  hashes: Record<string, string>,
) {
  const hash = createHash("sha256").update(`base:${base ?? "none"}\n${header}\n`);
  for (const path of [...paths].sort()) hash.update(`${path}\0${hashes[path] ?? "unhashed"}\n`);
  return hash.digest("hex");
}

export function gateFingerprint(input: {
  base: string | null;
  gate: ReadyPlan["gates"][number];
  changed: readonly string[];
  hashes: Record<string, string>;
  dependencies?: ReadyPlan["dependencies"];
}): string {
  const { gate } = input;
  return digest(
    input.base,
    JSON.stringify([gate.binary, gate.args, gate.cwd]),
    gatePaths(gate.name, input.changed, input.dependencies),
    input.hashes,
  );
}

/** Whether a changed path's E2E target selects the scenario or one of its prerequisites. */
export function scenarioPaths(scenario: string, changed: readonly string[]): string[] {
  const needed = new Set(expandE2EScenarios([scenario]));
  return changed.filter((path) => {
    const target = e2eTarget(path);
    if (target === AGENTS_FULL) return true;
    return [...needed].some(
      (name) =>
        target.scenarios?.includes(name) ||
        target.areas?.some((area) => scenarioAreas[name].includes(area)),
    );
  });
}

export function scenarioFingerprints(input: {
  base: string | null;
  scenarios: readonly string[];
  changed: readonly string[];
  hashes: Record<string, string>;
}): Record<string, string> {
  return Object.fromEntries(
    input.scenarios.map((name) => [
      name,
      digest(input.base, `scenario:${name}`, scenarioPaths(name, input.changed), input.hashes),
    ]),
  );
}

/** The mirror stage's fingerprint: the changed paths whose E2E target selects it. */
export function mirrorFingerprint(input: {
  base: string | null;
  changed: readonly string[];
  hashes: Record<string, string>;
}): string {
  const paths = input.changed.filter((path) => selectsMirror(e2eTarget(path)));
  return digest(input.base, "mirror", paths, input.hashes);
}

export interface Reused {
  kind: Kind;
  name: string;
  evidence: string;
  finishedAt: string;
  reason: string;
}

export interface ResumeDecision {
  /** Gates to run, in plan order. */
  gates: string[];
  /** Scenarios to run, prerequisites included, in suite order. */
  scenarios: ScenarioName[];
  /** Whether the mirror stage runs (false when it is not selected or is reused). */
  mirror: boolean;
  reused: Reused[];
  /** Why each gate or scenario that runs is not reused. */
  rerun: Record<string, string>;
}

/** What `--resume` reuses: only verdicts whose last attempt passed with the same inputs. */
export function resumeDecision(input: {
  history: ReadyHistory | null;
  /** Why the history cannot be used, when it cannot. */
  problem?: string;
  root: string;
  base: string | null;
  gates: readonly { name: string; fingerprint: string }[];
  scenarios: readonly { name: string; fingerprint: string }[];
  /** The selected mirror stage's fingerprint; omitted when it is not selected. */
  mirror?: string;
  now?: number;
}): ResumeDecision {
  const now = input.now ?? Date.now();
  const rerun: Record<string, string> = {};
  const reused: Reused[] = [];
  const verdict = (kind: Kind, name: string, fingerprint: string): string | Reused => {
    if (input.problem) return `nothing is reused: ${input.problem}`;
    if (!input.history || input.history.root !== input.root)
      return "nothing is reused: the ready history belongs to another worktree";
    if (input.base === null) return "nothing is reused without a merge base";
    if (kind === "gate" && name === "bindings")
      return "the bindings are missing now, whatever an earlier run generated";
    const attempt = input.history.attempts[`${kind}:${name}`];
    if (!attempt) return "no earlier attempt in the last 24 hours";
    if (!fresh(attempt, now)) return "the last attempt is older than 24 hours";
    if (attempt.base !== input.base) return `the merge base moved from ${attempt.base}`;
    if (attempt.fingerprint !== fingerprint)
      return kind === "gate"
        ? "its command or a changed path it reads differs from the last attempt"
        : kind === "mirror"
          ? "a changed path that selects it differs from the last attempt"
          : "a changed path that selects it or a prerequisite differs from the last attempt";
    if (attempt.outcome !== "passed") return `the last attempt failed (${attempt.evidence})`;
    return {
      kind,
      name,
      evidence: attempt.evidence,
      finishedAt: attempt.finishedAt,
      reason: "passed with the same merge base and inputs",
    };
  };
  const gates: string[] = [];
  for (const { name, fingerprint } of input.gates) {
    const result = verdict("gate", name, fingerprint);
    if (typeof result === "string") {
      gates.push(name);
      rerun[name] = result;
    } else reused.push(result);
  }
  const passed = new Map<string, Reused>();
  const failing: string[] = [];
  for (const { name, fingerprint } of input.scenarios) {
    const result = verdict("scenario", name, fingerprint);
    if (typeof result === "string") {
      failing.push(name);
      rerun[name] = result;
    } else passed.set(name, result);
  }
  // A scenario that runs brings its prerequisites: their state is gone with the old environment.
  const scenarios = expandE2EScenarios(failing);
  for (const name of scenarios) {
    if (rerun[name]) continue;
    const by = failing.filter((other) => expandE2EScenarios([other]).includes(name));
    rerun[name] = `a prerequisite of ${by.join(", ")}, which runs`;
  }
  for (const [name, entry] of passed)
    if (!(scenarios as readonly string[]).includes(name)) reused.push(entry);
  let mirror = false;
  if (input.mirror !== undefined) {
    const result = verdict("mirror", "mirror", input.mirror);
    if (typeof result === "string") {
      mirror = true;
      rerun.mirror = result;
    } else reused.push(result);
  }
  return { gates, scenarios, mirror, reused, rerun };
}

/** The verdicts in an e2e.json report; a scenario the run never reached has none. */
export function scenarioOutcomes(report: unknown): Record<string, "passed" | "failed"> {
  const outcomes: Record<string, "passed" | "failed"> = {};
  if (!Array.isArray(report)) return outcomes;
  for (const entry of report)
    if (
      entry &&
      typeof entry === "object" &&
      typeof entry.scenario === "string" &&
      (entry.status === "passed" || entry.status === "failed")
    )
      outcomes[entry.scenario] = entry.status;
  return outcomes;
}

/** The mirror stage's verdict in its mirror-e2e.json report, if it reached one. */
export function mirrorOutcome(report: unknown): "passed" | "failed" | null {
  if (!report || typeof report !== "object" || !("outcome" in report)) return null;
  return report.outcome === "passed" || report.outcome === "failed" ? report.outcome : null;
}
