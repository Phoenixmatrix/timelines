// Pure helpers: reading gm's JSON and the Bash commands that run gm.
import type { GmWork } from "../types";

const ISSUE_KEY = /^[A-Z][A-Z0-9]*-\d+$/;

/** One `gm issue <sub> [KEY]` (or any other gm command, as `sub: null`). */
export type GmCall = { sub: string | null; key: string | null };

/**
 * The gm commands in a shell command line, in order. `agent gm` (the
 * isolated product-testing wrapper) is skipped: it talks to another server.
 */
export function gmCalls(command: string): GmCall[] {
  const calls: GmCall[] = [];
  for (const segment of command.split(/&&|\|\||[;&|\n]/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    let at = 0;
    while (at < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at] ?? "")) at += 1;
    if (words[at] !== "gm" && !(words[at] ?? "").endsWith("/gm")) continue;
    if (segment.includes("agent gm")) continue;
    const rest = words.slice(at + 1);
    const issueAt = rest.indexOf("issue");
    if (issueAt === -1) {
      calls.push({ sub: null, key: null });
      continue;
    }
    const sub = rest[issueAt + 1] ?? null;
    const key = rest.slice(issueAt + 2).find((word) => ISSUE_KEY.test(word)) ?? null;
    calls.push({ sub, key });
  }
  return calls;
}

/** What the session's gm commands mean for the issue it is focused on. */
export function nextFocus(
  focus: string | null,
  calls: readonly GmCall[],
  output: string,
): string | null {
  let next = focus;
  for (const call of calls) {
    if (call.sub === "next") {
      next = claimedKey(output) ?? next;
    } else if (
      call.key &&
      ["claim", "resume", "checkpoint", "renew", "evidence"].includes(call.sub ?? "")
    ) {
      next = call.key;
    } else if (
      call.key &&
      ["complete", "release"].includes(call.sub ?? "") &&
      (next === null || next === call.key)
    ) {
      next = null;
    }
  }
  return next;
}

/** The key `gm issue next` claimed, from its JSON output. */
export function claimedKey(output: string): string | null {
  try {
    const parsed = JSON.parse(output) as { claimed?: { key?: unknown } | null };
    const key = parsed.claimed?.key;
    if (typeof key === "string") return key;
  } catch {
    // Not whole JSON (other output around it): fall back to a scan.
  }
  return /"claimed"\s*:\s*\{[^}]*?"key"\s*:\s*"([A-Z][A-Z0-9]*-\d+)"/.exec(output)?.[1] ?? null;
}

type Claim = { actorId?: string; agent?: string; expiresAt?: string } | null;
type ListedIssue = { key: string; updatedAt?: string; claim?: Claim };

/** In-progress issues whose live claim belongs to `agentId`, newest first. */
export function myClaims(list: unknown, agentId: string | null, now: number): ListedIssue[] {
  const issues = (list as { issues?: ListedIssue[] } | null)?.issues ?? [];
  return issues
    .filter((issue) => {
      const claim = issue.claim;
      if (!claim || !agentId || claim.actorId !== agentId) return false;
      return !claim.expiresAt || Date.parse(claim.expiresAt) > now;
    })
    .toSorted((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

/** The checkout's timeline from `gm timeline list`, if it works in one. */
export function currentTimeline(listed: unknown): string | null {
  const current = (listed as { current?: unknown } | null)?.current;
  if (typeof current === "string") return current;
  if (current && typeof current === "object") {
    const { name, slug } = current as { name?: unknown; slug?: unknown };
    if (typeof name === "string") return name;
    if (typeof slug === "string") return slug;
  }
  return null;
}

type Note = { kind?: string; body?: string; createdAt?: string };

/** The newest checkpoint's first line, markdown stripped. */
export function latestCheckpoint(notes: readonly Note[] | undefined): string | null {
  const checkpoint = (notes ?? [])
    .filter((note) => note.kind === "checkpoint" && note.body)
    .toSorted((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))[0];
  if (!checkpoint?.body) return null;
  const line = checkpoint.body.split("\n").find((text) => text.trim() !== "") ?? "";
  return (
    line
      .replace(/[*_`]+/g, "")
      .replace(/\s+/g, " ")
      .trim() || null
  );
}

/** The card's view of `gm issue show <key>`. */
export function toWork(
  shown: unknown,
  context: { agentId: string | null; timeline: string | null; otherClaims: number },
): GmWork {
  const { issue, notes } = shown as {
    issue: {
      key: string;
      title?: string;
      status?: string;
      priority?: number | null;
      claim?: Claim;
    };
    notes?: Note[];
  };
  const claim = issue.claim ?? null;
  const isMine = claim !== null && claim.actorId === context.agentId;
  return {
    key: issue.key,
    title: issue.title ?? "",
    status: issue.status ?? "unknown",
    priority: typeof issue.priority === "number" ? issue.priority : null,
    claimedBy: claim && !isMine ? (claim.agent ?? "someone else") : null,
    leaseExpiresAt: isMine ? (claim?.expiresAt ?? null) : null,
    timeline: context.timeline,
    checkpoint: latestCheckpoint(notes),
    otherClaims: context.otherClaims,
  };
}

/** `lease 41m`, `lease 1h05m`, or `lease expired`. */
export function leaseLabel(expiresAt: string | null, now: number): string | null {
  if (!expiresAt) return null;
  const minutes = Math.floor((Date.parse(expiresAt) - now) / 60_000);
  if (Number.isNaN(minutes)) return null;
  if (minutes < 0) return "lease expired";
  if (minutes < 60) return `lease ${minutes}m`;
  return `lease ${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** The second line: status, priority, lease or holder, timeline. */
export function metaLine(work: GmWork, now: number): string {
  const parts = [work.status.replace(/_/g, " ")];
  if (work.priority !== null) parts.push(`P${work.priority}`);
  const lease = leaseLabel(work.leaseExpiresAt, now);
  if (lease) parts.push(lease);
  if (work.claimedBy) parts.push(`held by ${work.claimedBy}`);
  if (work.timeline) parts.push(`⎇ ${work.timeline}`);
  return parts.join(" · ");
}

/** gm's error message from its JSON stderr, else the first line. */
export function gmErrorMessage(stderr: string): string | null {
  try {
    const parsed = JSON.parse(stderr) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string") return parsed.error.message;
  } catch {
    // Plain text.
  }
  return (
    stderr
      .split("\n")
      .find((line) => line.trim() !== "")
      ?.trim() ?? null
  );
}
