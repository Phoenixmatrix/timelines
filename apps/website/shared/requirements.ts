// What an issue requires of the agent that works on it (CORE-32), matched
// against what agents report about themselves (`AgentCapabilities`, published
// by `gm agent setup`). This is eligibility, not authorization: capabilities
// are self-reported, people can always claim, and repository and tracker
// permissions are enforced as before. Pure, so the Worker, the web tracker and
// the assistant share it; gm mirrors it (apps/cli/src/commands/requirements.rs).
//
// Text form, used by `gm issue create|update --requires`, the inspector and the
// assistant: space-separated terms, values comma-separated or repeated:
//
//   tag:ux skill:playwright model:claude-opus-*,gpt-5* harness:claude-code
//   os:linux arch:x86_64 runtime:host memory>=16GiB cpus>=8
//
// Tags and skills: the agent needs every one. Models, harnesses, os, arch and
// runtime: any one. Every value is matched case-insensitively, and `*` matches
// any run of characters. Memory takes B, KiB/MiB/GiB/TiB (K/M/G/T mean the
// same) or KB/MB/GB/TB (powers of 1000).

import type { AgentCapabilities } from "./api.ts";

export interface IssueRequirements {
  /** Every one of these tags (a team vocabulary: ux, data, gpu, infra…). */
  tags?: string[];
  /** Every one of these skills, by name. */
  skills?: string[];
  /** Any one of these models. */
  models?: string[];
  /** Any one of these harnesses (claude-code, codex…). */
  harnesses?: string[];
  /** Any one of these operating systems (linux, macos, windows…). */
  os?: string[];
  /** Any one of these architectures (x86_64, aarch64…). */
  arch?: string[];
  /** Any one of these runtimes (host, container, vm, wsl, cloudflare-worker). */
  runtime?: string[];
  /** At least this much memory, in bytes. */
  minMemory?: number;
  /** At least this many CPUs. */
  minCpus?: number;
}

export const REQUIREMENT_LISTS = [
  "tags",
  "skills",
  "models",
  "harnesses",
  "os",
  "arch",
  "runtime",
] as const;
export type RequirementList = (typeof REQUIREMENT_LISTS)[number];
export type RequirementKey = keyof IssueRequirements;

/** The term each list is written with: `tag:ux`, `model:claude-*`. */
export const LIST_TERMS: Record<RequirementList, string> = {
  tags: "tag",
  skills: "skill",
  models: "model",
  harnesses: "harness",
  os: "os",
  arch: "arch",
  runtime: "runtime",
};
/** Lists where the agent needs every value; the others need any one. */
const EVERY: readonly RequirementList[] = ["tags", "skills"];
const ALIASES: Record<string, RequirementList> = {
  tag: "tags",
  tags: "tags",
  skill: "skills",
  skills: "skills",
  model: "models",
  models: "models",
  harness: "harnesses",
  harnesses: "harnesses",
  os: "os",
  arch: "arch",
  runtime: "runtime",
};
export const MAX_REQUIREMENT_VALUES = 20;
const VALUE = /^[a-z0-9*][a-z0-9*._+/@-]*$/;
const MAX_MEMORY = 2 ** 50;
const MAX_CPUS = 4096;

export class RequirementError extends Error {}

const UNITS: Record<string, number> = {
  b: 1,
  k: 2 ** 10,
  kib: 2 ** 10,
  m: 2 ** 20,
  mib: 2 ** 20,
  g: 2 ** 30,
  gib: 2 ** 30,
  t: 2 ** 40,
  tib: 2 ** 40,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
};

/** "16GiB", "512MB", "1.5G", "17179869184": bytes, or null when it isn't a size. */
export function parseBytes(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(text.trim());
  if (!match) return null;
  const unit = UNITS[(match[2] || "b").toLowerCase()];
  if (unit === undefined) return null;
  const bytes = Math.round(Number(match[1]) * unit);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
}

/**
 * Bytes in the largest unit that keeps it whole, binary before decimal at
 * each size: 16GiB, 16GB, 1536MiB, 1000B.
 */
export function formatBytes(bytes: number): string {
  for (const [unit, size] of [
    ["TiB", 2 ** 40],
    ["TB", 1e12],
    ["GiB", 2 ** 30],
    ["GB", 1e9],
    ["MiB", 2 ** 20],
    ["MB", 1e6],
    ["KiB", 2 ** 10],
    ["KB", 1e3],
  ] as const)
    if (bytes >= size && bytes % size === 0) return `${bytes / size}${unit}`;
  return `${bytes}B`;
}

/** A reported amount of memory, roughly: "15.5GiB" (never parsed back). */
function roughBytes(bytes: number): string {
  if (bytes % 2 ** 20 === 0) return formatBytes(bytes);
  return bytes >= 2 ** 30
    ? `${Math.floor((bytes / 2 ** 30) * 10) / 10}GiB`
    : `${Math.floor(bytes / 2 ** 20)}MiB`;
}

/** Whether there is anything to meet: absent, null and empty mean any agent. */
export function hasRequirements(requires: IssueRequirements | null | undefined): boolean {
  if (!requires) return false;
  return (
    REQUIREMENT_LISTS.some((key) => (requires[key]?.length ?? 0) > 0) ||
    requires.minMemory !== undefined ||
    requires.minCpus !== undefined
  );
}

function listValues(value: unknown, key: RequirementList): string[] {
  if (!Array.isArray(value) || value.length > MAX_REQUIREMENT_VALUES)
    throw new RequirementError(
      `${key} must be a list of at most ${MAX_REQUIREMENT_VALUES} values.`,
    );
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new RequirementError(`${key} values must be text.`);
    const v = item.trim().toLowerCase();
    if (!v || v.length > 100 || !VALUE.test(v))
      throw new RequirementError(
        `Invalid ${LIST_TERMS[key]} "${item}": use letters, digits, . _ + / @ - and * (1–100 characters).`,
      );
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * The stored form of a `requires` value from a mutation: known keys only,
 * trimmed lowercase values without duplicates, whole positive numbers. Null
 * when it asks nothing. Throws RequirementError with what's wrong.
 */
export function normalizeRequirements(value: unknown): IssueRequirements | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value))
    throw new RequirementError("requires must be an object, or null for any agent.");
  const input = value as Record<string, unknown>;
  const out: IssueRequirements = {};
  for (const key of Object.keys(input)) {
    if (input[key] === undefined || input[key] === null) continue;
    if ((REQUIREMENT_LISTS as readonly string[]).includes(key)) {
      const values = listValues(input[key], key as RequirementList);
      if (values.length) out[key as RequirementList] = values;
    } else if (key === "minMemory" || key === "minCpus") {
      const n = input[key];
      const max = key === "minMemory" ? MAX_MEMORY : MAX_CPUS;
      if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1 || n > max)
        throw new RequirementError(`${key} must be a whole number from 1 to ${max}.`);
      out[key] = n;
    } else throw new RequirementError(`Unknown requirement: ${key}.`);
  }
  if (out.runtime)
    for (const runtime of out.runtime)
      if (!runtime.includes("*") && !RUNTIMES.includes(runtime))
        throw new RequirementError(`Unknown runtime "${runtime}": use ${RUNTIMES.join(", ")}.`);
  return hasRequirements(out) ? out : null;
}
const RUNTIMES = ["host", "container", "vm", "wsl", "cloudflare-worker", "unknown"];

/**
 * Parse the text form ("tag:ux model:claude-* memory>=16GiB") into stored
 * requirements; empty text is null (any agent). Throws RequirementError.
 */
export function parseRequirements(text: string): IssueRequirements | null {
  const draft: Record<string, unknown> = {};
  for (const term of text.split(/\s+/).filter(Boolean)) {
    const bound = /^(memory|mem|cpus|cpu)\s*>=\s*(.+)$/i.exec(term);
    if (bound) {
      const memory = bound[1]!.toLowerCase().startsWith("mem");
      const value = memory
        ? parseBytes(bound[2]!)
        : /^\d+$/.test(bound[2]!)
          ? Number(bound[2])
          : null;
      if (value === null || !Number.isSafeInteger(value) || value < 1)
        throw new RequirementError(
          memory
            ? `Invalid memory "${bound[2]}": use a size like 16GiB.`
            : `Invalid CPU count "${bound[2]}".`,
        );
      draft[memory ? "minMemory" : "minCpus"] = value;
      continue;
    }
    const at = term.indexOf(":");
    const key = at > 0 ? ALIASES[term.slice(0, at).toLowerCase()] : undefined;
    if (!key)
      throw new RequirementError(
        `Unknown requirement "${term}": use tag:, skill:, model:, harness:, os:, arch:, runtime:, memory>= or cpus>=.`,
      );
    const values = term
      .slice(at + 1)
      .split(",")
      .filter(Boolean);
    if (!values.length) throw new RequirementError(`"${term}" needs a value.`);
    draft[key] = [...((draft[key] as string[] | undefined) ?? []), ...values];
  }
  return normalizeRequirements(draft);
}

/** The text form, one term per value: "tag:ux model:claude-* memory>=16GiB". */
export function requirementsText(requires: IssueRequirements | null | undefined): string {
  return requirementTerms(requires).join(" ");
}

/** Each requirement as a term, for chips: ["tag:ux", "memory>=16GiB"]. */
export function requirementTerms(requires: IssueRequirements | null | undefined): string[] {
  if (!requires) return [];
  const terms: string[] = [];
  for (const key of REQUIREMENT_LISTS)
    for (const value of requires[key] ?? []) terms.push(`${LIST_TERMS[key]}:${value}`);
  if (requires.minMemory !== undefined) terms.push(`memory>=${formatBytes(requires.minMemory)}`);
  if (requires.minCpus !== undefined) terms.push(`cpus>=${requires.minCpus}`);
  return terms;
}

/** Requirements without one term (as `requirementTerms` writes it); null when nothing is left. */
export function withoutTerm(
  requires: IssueRequirements | null | undefined,
  term: string,
): IssueRequirements | null {
  return parseRequirements(
    requirementTerms(requires)
      .filter((t) => t !== term)
      .join(" "),
  );
}

/** `*` matches any run of characters; everything else literally, ignoring case. */
export function globMatch(pattern: string, value: string): boolean {
  const source = pattern
    .toLowerCase()
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(value.toLowerCase());
}

/** One requirement an agent doesn't meet, and why. */
export interface UnmetRequirement {
  /** The requirement's key, or `capabilities` when the agent never reported any. */
  requirement: RequirementKey | "capabilities";
  /** The term it asks for: "tag:ux", "model:claude-opus-*,gpt-5*", "memory>=16GiB". */
  wanted: string;
  /** What the agent reported for it, or null. */
  reported: string | null;
  /** In words: "needs tag ux (it reports: data, gpu)". */
  message: string;
}

/**
 * Every requirement `capabilities` doesn't meet: empty when it's eligible.
 * An agent that never reported capabilities meets nothing but an empty
 * requirement, and is told to run `gm agent setup`.
 */
export function unmetRequirements(
  requires: IssueRequirements | null | undefined,
  capabilities: AgentCapabilities | null | undefined,
): UnmetRequirement[] {
  if (!requires || !hasRequirements(requires)) return [];
  if (!capabilities)
    return [
      {
        requirement: "capabilities",
        wanted: requirementsText(requires),
        reported: null,
        message:
          "it hasn't reported its capabilities: run `gm agent setup` in its checkout to publish them",
      },
    ];
  const env = capabilities.environment;
  const reported: Record<RequirementList, string[]> = {
    tags: capabilities.tags ?? [],
    skills: (capabilities.skills ?? []).map((skill) => skill.name),
    models: capabilities.model ? [capabilities.model] : [],
    harnesses: capabilities.harness ? [capabilities.harness] : [],
    os: env?.os ? [env.os] : [],
    arch: env?.arch ? [env.arch] : [],
    runtime: env?.runtime ? [env.runtime] : [],
  };
  const unmet: UnmetRequirement[] = [];
  const has = (key: RequirementList) => (reported[key].length ? reported[key].join(", ") : null);
  const singular: Record<RequirementList, string> = {
    tags: "tag",
    skills: "skill",
    models: "model",
    harnesses: "harness",
    os: "OS",
    arch: "architecture",
    runtime: "runtime",
  };
  for (const key of REQUIREMENT_LISTS) {
    const wanted = requires[key] ?? [];
    if (!wanted.length) continue;
    const said = has(key);
    const suffix = said
      ? ` (it reports ${EVERY.includes(key) ? `${singular[key]}s: ` : ""}${said})`
      : ` (it reports no ${EVERY.includes(key) ? `${singular[key]}s` : singular[key]})`;
    if (EVERY.includes(key)) {
      for (const value of wanted)
        if (!reported[key].some((have) => globMatch(value, have)))
          unmet.push({
            requirement: key,
            wanted: `${LIST_TERMS[key]}:${value}`,
            reported: said,
            message: `needs ${singular[key]} ${value}${suffix}`,
          });
    } else if (!wanted.some((value) => reported[key].some((have) => globMatch(value, have))))
      unmet.push({
        requirement: key,
        wanted: `${LIST_TERMS[key]}:${wanted.join(",")}`,
        reported: said,
        message: `needs ${wanted.length > 1 ? `one of ${singular[key]} ` : `${singular[key]} `}${wanted.join(", ")}${suffix}`,
      });
  }
  if (requires.minMemory !== undefined) {
    const memory = env?.memoryBytes ?? null;
    if (memory === null || memory < requires.minMemory)
      unmet.push({
        requirement: "minMemory",
        wanted: `memory>=${formatBytes(requires.minMemory)}`,
        reported: memory === null ? null : roughBytes(memory),
        message: `needs at least ${formatBytes(requires.minMemory)} of memory (${memory === null ? "it reports none" : `it reports ${roughBytes(memory)}`})`,
      });
  }
  if (requires.minCpus !== undefined) {
    const cpus = env?.cpuCount ?? null;
    if (cpus === null || cpus < requires.minCpus)
      unmet.push({
        requirement: "minCpus",
        wanted: `cpus>=${requires.minCpus}`,
        reported: cpus === null ? null : String(cpus),
        message: `needs at least ${requires.minCpus} CPUs (${cpus === null ? "it reports none" : `it reports ${cpus}`})`,
      });
  }
  return unmet;
}

/** "builder doesn't meet CORE-12's requirements: needs tag ux (…); needs …." */
export function unmetText(agent: string, key: string, unmet: UnmetRequirement[]): string {
  return `${agent} doesn't meet ${key}'s requirements: ${unmet.map((u) => u.message).join("; ")}.`;
}
