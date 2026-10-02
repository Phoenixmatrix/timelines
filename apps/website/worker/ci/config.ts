// The pipeline a repository declares in .gitmatrix/ci.yml:
//
//   on:
//     push:
//       branches: [main, "release/*"]   # globs; omit to run on every branch
//       coalesce_after: 4   # with 4 runs in flight on a branch, later pushes share one run
//   env:
//     CI: "true"
//   jobs:
//     check:
//       steps:
//         - name: Install
//           run: pnpm install --frozen-lockfile
//         - run: vp check
//     deploy:
//       needs: [check]
//       if: branch == "main"
//       secrets: [CLOUDFLARE_API_TOKEN]
//       timeout_minutes: 15
//       image: default          # sandbox image (see cloudflare.config.ts)
//       instance: standard-1    # sandbox size
//       concurrency: production  # one at a time per repo; superseded runs skip it
//       paths: [apps/cli]        # pushes skip it while these are unchanged since it last passed
//       steps:
//         - run: cf deploy

import { parse } from "yaml";

export const CONFIG_PATH = ".gitmatrix/ci.yml";

export interface StepSpec {
  name: string;
  run: string;
}

export type Instance = "lite" | "standard-1" | "standard-2" | "standard-3" | "standard-4";

export interface JobSpec {
  name: string;
  needs: string[];
  if: string | null;
  image: string;
  instance: Instance;
  env: Record<string, string>;
  secrets: string[];
  timeoutMinutes: number;
  steps: StepSpec[];
  /**
   * One job of a group runs at a time per repository, and a waiting one is
   * skipped once a newer run on its branch has its own (e.g. deploys).
   */
  concurrency?: string | null;
  /**
   * Files or directories (no globs) the job depends on. On a push, a job whose
   * paths are identical to the last commit it passed on the branch is skipped as
   * unchanged, and counts as passed for the jobs that need it.
   */
  paths?: string[];
}

export interface Pipeline {
  branches: string[] | null;
  /** Runs in flight on a branch before further pushes coalesce into one held run. */
  coalesceAfter: number | null;
  env: Record<string, string>;
  jobs: JobSpec[];
}

export class ConfigError extends Error {}

const INSTANCES = new Set<Instance>([
  "lite",
  "standard-1",
  "standard-2",
  "standard-3",
  "standard-4",
]);
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

function record(value: unknown, where: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value))
    throw new ConfigError(`${where} must be a mapping.`);
  return value as Record<string, unknown>;
}

function stringMap(value: unknown, where: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record(value, where))) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
      throw new ConfigError(`${where}: "${k}" is not a valid variable name.`);
    if (typeof v === "object" && v !== null)
      throw new ConfigError(`${where}.${k} must be a plain value.`);
    out[k] = String(v);
  }
  return out;
}

function stringList(value: unknown, where: string): string[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => {
    if (typeof item !== "string") throw new ConfigError(`${where} must list strings.`);
    return item;
  });
}

/** Parse and validate ci.yml; throws ConfigError with a message for people. */
export function parsePipeline(source: string): Pipeline {
  let doc: unknown;
  try {
    doc = parse(source);
  } catch (error) {
    throw new ConfigError(
      `${CONFIG_PATH} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const root = record(doc, CONFIG_PATH);
  const on = record(root.on, "on");
  const push = record(on.push, "on.push");
  const branches =
    push.branches === undefined ? null : stringList(push.branches, "on.push.branches");
  let coalesceAfter: number | null = null;
  if (push.coalesce_after !== undefined) {
    coalesceAfter = Number(push.coalesce_after);
    if (!Number.isInteger(coalesceAfter) || coalesceAfter < 1 || coalesceAfter > 50)
      throw new ConfigError("on.push.coalesce_after must be a whole number from 1 to 50.");
  }
  const env = stringMap(root.env, "env");

  const jobsRaw = record(root.jobs, "jobs");
  if (Object.keys(jobsRaw).length === 0) throw new ConfigError(`${CONFIG_PATH} declares no jobs.`);
  const jobs: JobSpec[] = Object.entries(jobsRaw).map(([name, raw]) => {
    if (!NAME.test(name))
      throw new ConfigError(`Job name "${name}" may only use letters, digits, - and _.`);
    const job = record(raw, `jobs.${name}`);
    const stepsRaw = job.steps;
    if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
      throw new ConfigError(`jobs.${name}.steps must list at least one step.`);
    }
    const steps = stepsRaw.map((s, i): StepSpec => {
      const step = typeof s === "string" ? { run: s } : record(s, `jobs.${name}.steps[${i}]`);
      if (typeof step.run !== "string" || !step.run.trim()) {
        throw new ConfigError(`jobs.${name}.steps[${i}] needs a run command.`);
      }
      const firstLine = step.run.trim().split("\n")[0] ?? "";
      return {
        name: typeof step.name === "string" ? step.name : firstLine.slice(0, 80),
        run: step.run,
      };
    });
    const instance = (job.instance ?? "standard-1") as Instance;
    if (!INSTANCES.has(instance))
      throw new ConfigError(`jobs.${name}.instance must be one of ${[...INSTANCES].join(", ")}.`);
    const timeout = Number(job.timeout_minutes ?? 20);
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 120) {
      throw new ConfigError(`jobs.${name}.timeout_minutes must be between 1 and 120.`);
    }
    if (job.if !== undefined && typeof job.if !== "string")
      throw new ConfigError(`jobs.${name}.if must be a string.`);
    if (
      job.concurrency !== undefined &&
      (typeof job.concurrency !== "string" || !NAME.test(job.concurrency))
    )
      throw new ConfigError(`jobs.${name}.concurrency must be a name like "production".`);
    const paths = stringList(job.paths, `jobs.${name}.paths`).map((path) => {
      const clean = path.replace(/\/+$/, "");
      if (!clean || clean.startsWith("/") || /[*?[\]]|(^|\/)\.\.?(\/|$)/.test(clean))
        throw new ConfigError(
          `jobs.${name}.paths lists files or directories in the repository, like apps/cli (no globs).`,
        );
      return clean;
    });
    return {
      name,
      needs: stringList(job.needs, `jobs.${name}.needs`),
      if: (job.if as string | undefined) ?? null,
      image: typeof job.image === "string" ? job.image : "default",
      instance,
      env: stringMap(job.env, `jobs.${name}.env`),
      secrets: stringList(job.secrets, `jobs.${name}.secrets`),
      timeoutMinutes: timeout,
      steps,
      concurrency: (job.concurrency as string | undefined) ?? null,
      paths,
    };
  });

  // needs must name jobs, and must not loop.
  const names = new Set(jobs.map((j) => j.name));
  for (const job of jobs) {
    for (const need of job.needs) {
      if (!names.has(need))
        throw new ConfigError(`jobs.${job.name}.needs names unknown job "${need}".`);
    }
    if (job.if) evaluate(job.if, { branch: "", trigger: "push", commit: "", runner: "local" });
  }
  stages(jobs);
  return { branches, coalesceAfter, env, jobs };
}

/** Jobs grouped into stages: each stage only needs jobs from earlier stages. */
export function stages(jobs: JobSpec[]): JobSpec[][] {
  const done = new Set<string>();
  const left = [...jobs];
  const out: JobSpec[][] = [];
  while (left.length) {
    const ready = left.filter((j) => j.needs.every((n) => done.has(n)));
    if (ready.length === 0)
      throw new ConfigError(
        `Jobs ${left.map((j) => j.name).join(", ")} depend on each other in a cycle.`,
      );
    out.push(ready);
    for (const j of ready) {
      done.add(j.name);
      left.splice(left.indexOf(j), 1);
    }
  }
  return out;
}

/** Glob match for branch filters: `*` matches within a segment, `**` across. */
export function branchMatches(branch: string, patterns: string[] | null): boolean {
  if (patterns === null) return true;
  return patterns.some((pattern) => {
    const re = pattern
      .split("**")
      .map((part) =>
        part
          .split("*")
          .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join("[^/]*"),
      )
      .join(".*");
    return new RegExp(`^${re}$`).test(branch);
  });
}

export interface ConditionContext {
  branch: string;
  trigger: "push" | "manual";
  commit: string;
  /** Where jobs run: "local" (gm runner under vp dev) or "sandbox" (deployed). */
  runner: "local" | "sandbox";
}

/**
 * Evaluate a job's `if:` — comparisons of `branch`, `trigger`, `commit` or `runner`
 * with quoted strings using == and !=, joined by && and ||, with parentheses.
 */
export function evaluate(expression: string, context: ConditionContext): boolean {
  const tokens = expression
    .match(/\s*(\(|\)|&&|\|\||==|!=|"[^"]*"|'[^']*'|[A-Za-z_]+)\s*/g)
    ?.map((t) => t.trim());
  if (!tokens || tokens.join("") !== expression.replace(/\s+/g, "")) {
    throw new ConfigError(`Can't read the condition "${expression}".`);
  }
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const value = (): string => {
    const token = next();
    if (!token) throw new ConfigError(`Condition "${expression}" ends early.`);
    if (/^["']/.test(token)) return token.slice(1, -1);
    if (token in context) return context[token as keyof ConditionContext];
    throw new ConfigError(
      `Unknown name "${token}" in condition; use branch, trigger, commit or runner.`,
    );
  };
  const comparison = (): boolean => {
    if (peek() === "(") {
      next();
      const result = or();
      if (next() !== ")") throw new ConfigError(`Missing ) in "${expression}".`);
      return result;
    }
    const left = value();
    const op = next();
    if (op !== "==" && op !== "!=") throw new ConfigError(`Expected == or != in "${expression}".`);
    const right = value();
    return op === "==" ? left === right : left !== right;
  };
  const and = (): boolean => {
    let result = comparison();
    while (peek() === "&&") {
      next();
      result = comparison() && result;
    }
    return result;
  };
  const or = (): boolean => {
    let result = and();
    while (peek() === "||") {
      next();
      result = and() || result;
    }
    return result;
  };
  const result = or();
  if (i !== tokens.length) throw new ConfigError(`Unexpected "${peek()}" in "${expression}".`);
  return result;
}
