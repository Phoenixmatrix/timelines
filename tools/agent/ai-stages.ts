// Which real-provider stages `vp run agent test-ai` runs (CORE-284).
//
// Every stage is defined beside the scenario that runs it, with the
// repository-relative path globs whose changes it verifies:
// COPPER_FINCH_STAGES in provider-e2e.ts and ATLAS_STAGES in
// atlas-provider-e2e.ts. A change matching SHARED_PATHS runs every stage.
//
// The rules that keep targeting honest:
//
// - A stage runs when any changed path (against the merge base with
//   origin/main, plus uncommitted and untracked files) matches its globs or
//   SHARED_PATHS. `--stage` and `--all` only add stages: targeting never skips
//   a stage whose code changed.
// - A selected stage brings the stages it `requires` (a fresh environment
//   has none of their state), and runs every one with its real assertions.
// - `--resume` skips only a stage that passed in this worktree's previous run
//   from the same merge base, with the same content in every changed file
//   that maps to it (its fingerprint). Prerequisites still run.
// - After a failure, a full run is refused for COOLDOWN_MS, and so is a rerun
//   with nothing changed since the failure, unless `--force`.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, matchesGlob } from "node:path";
import { command, privateJson } from "./environment.ts";
import { ATLAS_STAGES } from "./atlas-provider-e2e.ts";
import { COPPER_FINCH_STAGES } from "./provider-e2e.ts";

export interface StageDefinition {
  id: string;
  /** What the stage verifies against the real providers. */
  covers: string;
  /** Stages whose state this one builds on; they run first. */
  requires: readonly string[];
  /** Repository-relative globs (path.matchesGlob) whose changes run this stage. */
  paths: readonly string[];
}

/**
 * Changes here can affect every stage: the harness's shared lifecycle, the
 * bindings and Worker entry points, the model layer and AI settings, and
 * dependency versions (the AI SDKs).
 */
export const SHARED_PATHS = [
  "tools/agent/ai-stages.ts",
  "tools/agent/main.ts",
  "tools/agent/environment.ts",
  "tools/agent/seed.ts",
  "tools/agent/types.ts",
  "tools/agent/package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "apps/website/package.json",
  "apps/website/cloudflare.config.ts",
  "apps/website/vite/environment.ts",
  "apps/website/worker/index.ts",
  "apps/website/worker/app.ts",
  "apps/website/worker/ai-gateway.ts",
  "apps/website/worker/knowledge/models.ts",
  "apps/website/worker/ai-providers/**",
  "apps/website/worker/settings/**",
  "apps/website/worker/usage/ai.ts",
  "apps/website/shared/ai.ts",
] as const;

export const AI_STAGES: readonly StageDefinition[] = [...COPPER_FINCH_STAGES, ...ATLAS_STAGES];
export const STAGE_IDS = AI_STAGES.map((stage) => stage.id);
const byId = new Map(AI_STAGES.map((stage) => [stage.id, stage]));

/** After a failed run: no full run, and no rerun of unchanged code, for this long. */
export const COOLDOWN_MS = 30 * 60_000;

export type Reason =
  | { kind: "changed"; paths: string[] }
  | { kind: "requested" }
  | { kind: "all" }
  | { kind: "required"; by: string[] };

export interface Selection {
  /** In execution order, prerequisites included. */
  stages: string[];
  /** Why each selected stage runs. */
  reasons: Record<string, Reason[]>;
  /** Stages left out, and why (no matching change, or passed before with the same inputs). */
  skipped: Record<string, string>;
  base: string | null;
  changed: string[];
  fingerprints: Record<string, string>;
}

export type Outcome = "passed" | "failed";

/** The stages a set of changed paths runs directly, with the paths that matched each. */
export function stagesForPaths(changed: readonly string[]): Map<string, string[]> {
  const matched = new Map<string, string[]>();
  for (const path of changed) {
    const shared = SHARED_PATHS.some((glob) => matchesGlob(path, glob));
    for (const stage of AI_STAGES)
      if (shared || stage.paths.some((glob) => matchesGlob(path, glob)))
        matched.set(stage.id, [...(matched.get(stage.id) ?? []), path]);
  }
  return matched;
}

export function assertStages(ids: readonly string[]): void {
  for (const id of ids)
    if (!byId.has(id))
      throw new Error(`Unknown test-ai stage ${id}. Stages: ${STAGE_IDS.join(", ")}.`);
}

/**
 * The stages to run: changed paths, plus `requested` and `all`, minus what
 * `reusable` says passed before with the same inputs, plus prerequisites.
 */
export function selectStages(options: {
  changed: readonly string[];
  requested?: readonly string[];
  all?: boolean;
  /** Stages that may be skipped: passed before with these exact inputs. */
  reusable?: ReadonlySet<string>;
  base?: string | null;
  fingerprints?: Record<string, string>;
}): Selection {
  assertStages(options.requested ?? []);
  const reasons: Record<string, Reason[]> = {};
  const add = (id: string, reason: Reason) => (reasons[id] ??= []).push(reason);
  for (const [id, paths] of stagesForPaths(options.changed)) add(id, { kind: "changed", paths });
  for (const id of options.requested ?? []) add(id, { kind: "requested" });
  if (options.all) for (const id of STAGE_IDS) add(id, { kind: "all" });
  const skipped: Record<string, string> = {};
  for (const id of Object.keys(reasons))
    if (options.reusable?.has(id)) {
      skipped[id] = "passed in the previous run with the same inputs (--resume)";
      delete reasons[id];
    }
  // Prerequisites run whether or not they passed before: the environment is new.
  const visit = (id: string) => {
    for (const required of byId.get(id)!.requires) {
      const entry = (reasons[required] ??= []);
      const existing = entry.find((reason) => reason.kind === "required");
      if (existing && existing.kind === "required") {
        if (!existing.by.includes(id)) existing.by.push(id);
      } else entry.push({ kind: "required", by: [id] });
      delete skipped[required];
      visit(required);
    }
  };
  for (const id of Object.keys(reasons)) visit(id);
  for (const id of STAGE_IDS) if (!reasons[id] && !skipped[id]) skipped[id] = "no matching change";
  return {
    stages: STAGE_IDS.filter((id) => reasons[id]),
    reasons,
    skipped,
    base: options.base ?? null,
    changed: [...options.changed],
    fingerprints: options.fingerprints ?? {},
  };
}

/**
 * Per stage, a hash of the content of every changed path that maps to it:
 * equal fingerprints from the same base mean the stage's changed code is the same.
 */
export async function fingerprints(
  root: string,
  base: string | null,
  changed: readonly string[],
): Promise<Record<string, string>> {
  const contents = new Map<string, string>();
  for (const path of changed) {
    const content = await readFile(join(root, path)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "EISDIR") return null;
      throw error;
    });
    contents.set(
      path,
      content ? createHash("sha256").update(content).digest("hex") : "deleted-or-directory",
    );
  }
  const matched = stagesForPaths(changed);
  return Object.fromEntries(
    STAGE_IDS.map((id) => {
      const hash = createHash("sha256").update(`base:${base ?? "none"}\n`);
      for (const path of [...(matched.get(id) ?? [])].sort())
        hash.update(`${path}\0${contents.get(path)}\n`);
      return [id, hash.digest("hex")];
    }),
  );
}

/** Paths changed against the merge base with `base`: commits, the working tree and untracked files. */
export async function changedPaths(
  root: string,
  base = "origin/main",
): Promise<{ base: string; changed: string[] }> {
  const git = (args: string[]) => command("git", args, { cwd: root, timeout: 60_000 });
  const mergeBase = (await git(["merge-base", base, "HEAD"])).trim();
  const tracked = await git(["diff", "--name-only", "--no-renames", mergeBase]);
  const untracked = await git(["ls-files", "--others", "--exclude-standard"]);
  const changed = [
    ...new Set([...tracked.split("\n"), ...untracked.split("\n")].filter(Boolean)),
  ].sort();
  return { base: mergeBase, changed };
}

export interface TestAiOptions {
  all: boolean;
  stages: string[];
  resume: boolean;
  force: boolean;
  dryRun: boolean;
  base: string;
}

export function parseTestAiOptions(args: readonly string[]): TestAiOptions {
  const options: TestAiOptions = {
    all: false,
    stages: [],
    resume: false,
    force: false,
    dryRun: false,
    base: "origin/main",
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const [flag, inline] = arg.includes("=") ? arg.split(/=(.*)/s) : [arg, undefined];
    const value = () => {
      const next = inline ?? args[++i];
      if (!next) throw new Error(`${flag} needs a value.`);
      return next;
    };
    if (flag === "--all") options.all = true;
    else if (flag === "--stage")
      options.stages.push(
        ...value()
          .split(",")
          .map((stage) => stage.trim())
          .filter(Boolean),
      );
    else if (flag === "--resume") options.resume = true;
    else if (flag === "--force") options.force = true;
    else if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--base") options.base = value();
    else
      throw new Error(
        "Use test-ai [--stage <id>[,<id>]] [--all] [--resume] [--force] [--dry-run] [--base <ref>].",
      );
  }
  assertStages(options.stages);
  return options;
}

export function parseSetupOptions(args: readonly string[]): { ai: boolean } {
  for (const arg of args)
    if (arg !== "--ai") throw new Error("Use setup [--ai]; --ai provisions paid AI resources.");
  return { ai: args.includes("--ai") };
}

/** One test-ai run, kept per worktree for --resume and the failure cooldown. */
export interface RunRecord {
  startedAt: string;
  finishedAt: string;
  success: boolean;
  base: string | null;
  stages: string[];
  fingerprints: Record<string, string>;
  outcomes: Record<string, Outcome>;
  failedStages: string[];
  evidence: string;
}

export function historyPath(root: string): string {
  return join(root, ".gitmatrix-agent", "test-ai", "history.json");
}

export async function readHistory(root: string): Promise<RunRecord[]> {
  try {
    const value = JSON.parse(await readFile(historyPath(root), "utf8")) as unknown;
    return Array.isArray(value) ? (value as RunRecord[]) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function appendHistory(root: string, record: RunRecord): Promise<void> {
  const history = await readHistory(root);
  await privateJson(historyPath(root), [...history, record].slice(-20));
}

/** Stages the previous run passed whose inputs (base and fingerprint) are unchanged. */
export function reusableStages(
  previous: RunRecord | undefined,
  base: string | null,
  current: Record<string, string>,
): Set<string> {
  if (!previous || previous.base !== base) return new Set();
  return new Set(
    Object.entries(previous.outcomes)
      .filter(
        ([id, outcome]) =>
          outcome === "passed" && current[id] && previous.fingerprints[id] === current[id],
      )
      .map(([id]) => id),
  );
}

/**
 * Why this run must not start, or null. After a failure within the cooldown:
 * never a full run, and never the same stages again with nothing changed.
 */
export function refusal(
  history: readonly RunRecord[],
  selection: Selection,
  now = Date.now(),
): string | null {
  const failed = history.findLast((record) => !record.success);
  if (!failed || history.at(-1) !== failed) return null;
  const since = now - Date.parse(failed.finishedAt);
  if (!(since >= 0 && since < COOLDOWN_MS)) return null;
  const minutes = Math.ceil((COOLDOWN_MS - since) / 60_000);
  const where = failed.failedStages.length ? ` at ${failed.failedStages.join(", ")}` : "";
  const next =
    `Inspect ${failed.evidence}, fix the cause, then run --resume (failed, unreached and changed ` +
    `stages only) or --stage <id>. --force overrides; never rerun in a loop.`;
  if (selection.stages.length === STAGE_IDS.length)
    return `The last test-ai run failed${where} ${Math.floor(since / 60_000)} min ago; a full run is refused for ${minutes} more min. ${next}`;
  const unchanged =
    failed.base === selection.base &&
    selection.stages.every((id) => failed.fingerprints[id] === selection.fingerprints[id]);
  if (unchanged)
    return `Nothing these stages verify changed since the last test-ai run failed${where} ${Math.floor(since / 60_000)} min ago. ${next}`;
  return null;
}
